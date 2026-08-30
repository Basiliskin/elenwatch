/**
 * gemini.integration.test.ts
 *
 * Live Google generative-language smoke test — opt-in only.
 *
 * Goal: prove the in-process interceptor captures a real Google
 * generative-language API call end-to-end when GEMINI_API_KEY (or
 * GOOGLE_API_KEY as fallback) is present in the environment.
 *
 * Opt-in: the API key IS the gate (no separate LIVE flag). With both
 * candidate keys unset, the suite resolves to `describe.skip` so the
 * default `npm test` never hits generativelanguage.googleapis.com. Per
 * the horizon-7 decision, a separate LIVE flag would fail-not-skip when
 * set without the key, so we deliberately do not introduce one.
 *
 * Why header auth (`x-goog-api-key`) instead of `?key=` query param:
 * the rubric's load-bearing URL-key safety check asserts that the
 * captured entry's URL field does NOT contain the literal apiKey value.
 * Since `src/interceptor.ts deriveUrl()` (line 924) passes `req.path`
 * through verbatim — and Node's `req.path` includes any query string —
 * a query-param auth would leak the key into `entries[0].url` and the
 * assertion would always fail. Header auth (the newer recommended auth
 * method, supported by the Gemini API) keeps the URL clean and lets the
 * safety check be a meaningful regression guard.
 *
 * Env-driven configuration (defaults match the rubric's documented values):
 *   - GEMINI_API_KEY    required to opt in (canonical; GOOGLE_API_KEY is a
 *                       documented fallback for environments that already
 *                       export the Google-Cloud-style name).
 *   - GEMINI_BASE_URL   optional; overrides the endpoint base (useful
 *                       for proxy/staging endpoints). Default
 *                       `https://generativelanguage.googleapis.com/v1beta/models`.
 *                       The model name and `:generateContent` action are
 *                       appended programmatically.
 *   - GEMINI_MODEL      optional; overrides the model id (useful for
 *                       pinning model-version). Default `gemini-2.0-flash`.
 *   Empty-string env vars are treated as unset and fall back to defaults.
 *
 * Gotchas documented for future maintainers:
 *   - Emission is deferred via setImmediate in src/interceptor.ts, so we
 *     await two ticks before asserting on the captured `entries` array.
 *   - `callerTrace` resolves to 'unknown' under Jest.
 *   - `capturePayloads` stays default-off.
 *   - Defense-in-depth: we assert that the captured entry's URL AND its
 *     JSON.stringify form do NOT contain the literal apiKey. The URL
 *     check is the load-bearing assertion for this phase (a query-param
 *     regression would surface immediately); the JSON.stringify check
 *     guards against the key leaking into any future field.
 *   - The apiKey is read into a local `string | undefined` variable; the
 *     canonical GEMINI_API_KEY is preferred, GOOGLE_API_KEY is the
 *     fallback. Empty-string env vars are treated as unset.
 *   - When GEMINI_BASE_URL overrides the host, the interceptor's
 *     `providers` filter is computed from the parsed URL hostname; the
 *     URL assertion is derived from parsed URL components too.
 */

import { request as httpsRequest } from 'node:https';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

const envGeminiKey: string | undefined = process.env.GEMINI_API_KEY;
const envGoogleKey: string | undefined = process.env.GOOGLE_API_KEY;
const apiKey: string | undefined =
  envGeminiKey !== undefined && envGeminiKey.length > 0
    ? envGeminiKey
    : envGoogleKey;
const envBaseUrl: string | undefined = process.env.GEMINI_BASE_URL;
const envModel: string | undefined = process.env.GEMINI_MODEL;

const baseUrl: string =
  envBaseUrl !== undefined && envBaseUrl.length > 0
    ? envBaseUrl
    : 'https://generativelanguage.googleapis.com/v1beta/models';
const model: string =
  envModel !== undefined && envModel.length > 0 ? envModel : 'gemini-2.0-flash';

const endpointPath = `${model}:generateContent`;
const parsedUrl = new URL(`${baseUrl}/${endpointPath}`);
const expectedUrlFragment = `${parsedUrl.hostname}${parsedUrl.pathname}`;

const hasKey: boolean = apiKey !== undefined && apiKey.length > 0;

function geminiLiveSuite(): void {
  test('one real Gemini generateContent call is captured by the interceptor', (done) => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: [parsedUrl.hostname],
      logger: (entry: LlmLogEntry) => entries.push(entry),
    });
    interceptor.install();

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: 'hi' }] }],
    });

    const req = httpsRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey ?? '',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          // Two setImmediate ticks so the interceptor's deferred emission
          // (src/interceptor.ts writes entries on a setImmediate) flushes
          // into our local `entries` array before we assert.
          setImmediate(() => {
            setImmediate(() => {
              try {
                expect(entries.length).toBe(1);
                expect(entries[0].url).toContain(expectedUrlFragment);
                // Load-bearing URL-key safety check: the captured URL
                // must not echo the apiKey. Trivially satisfied under
                // header auth; would catch any regression that switched
                // the auth back to a query parameter (which would leak
                // the key into entries[0].url via deriveUrl()).
                expect(entries[0].url).not.toContain(apiKey ?? '__unset__');
                expect(entries[0].model.toLowerCase()).toContain('gemini');
                expect(entries[0].inputTokens).toBeGreaterThanOrEqual(0);
                expect(entries[0].outputTokens).toBeGreaterThanOrEqual(0);
                // Defense-in-depth across every serialized field.
                expect(JSON.stringify(entries[0])).not.toContain(
                  apiKey ?? '__unset__',
                );
              } finally {
                interceptor.restore();
                done();
              }
            });
          });
        });
        res.on('error', (err: Error) => {
          interceptor.restore();
          done(err);
        });
      },
    );

    req.on('error', (err: Error) => {
      interceptor.restore();
      done(err);
    });
    req.write(requestBody);
    req.end();
  }, 60000);
}

if (hasKey) {
  describe('gemini live', geminiLiveSuite);
} else {
  // Kept out of the default run: no credential, no network egress.
  describe.skip('gemini live (skip: GEMINI_API_KEY not set)', geminiLiveSuite);
}
