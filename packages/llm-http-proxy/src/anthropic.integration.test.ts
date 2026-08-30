/**
 * anthropic.integration.test.ts
 *
 * Live Anthropic Messages API smoke test — opt-in only.
 *
 * Goal: prove the in-process interceptor captures a real Anthropic
 * Messages API call end-to-end when ANTHROPIC_API_KEY is present in the
 * environment.
 *
 * Opt-in: the API key IS the gate (no separate LIVE flag). With the key
 * unset, the suite resolves to `describe.skip` so the default `npm test`
 * never hits api.anthropic.com. Per the horizon-7 decision, a separate
 * LIVE flag would fail-not-skip when set without the key, so we deliberately
 * do not introduce one.
 *
 * Env-driven configuration (defaults match the rubric's documented values):
 *   - ANTHROPIC_API_KEY  required to opt in (above)
 *   - ANTHROPIC_BASE_URL optional; overrides the request target (useful
 *                       for proxy/staging endpoints). Default
 *                       `https://api.anthropic.com/v1/messages`.
 *   - ANTHROPIC_MODEL    optional; overrides the model id (useful for
 *                       pinning model-version). Default
 *                       `claude-3-5-haiku-20241022`.
 *   Empty-string env vars are treated as unset and fall back to defaults.
 *
 * Gotchas documented for future maintainers:
 *   - Emission is deferred via setImmediate in src/interceptor.ts, so we
 *     await two ticks before asserting on the captured `entries` array
 *     (same flush pattern as src/interceptor.test.ts lines 75-91 and the
 *     fetch-baseline integration test).
 *   - `callerTrace` resolves to 'unknown' under Jest (the interceptor
 *     passes 'unknown' when no caller trace is supplied — see
 *     src/interceptor.ts:427), so we do NOT assert on it.
 *   - `capturePayloads` stays default-off so the emitted entry has no
 *     masked-body fields; we assert on model / url / token counts only.
 *   - Defense-in-depth: even though Anthropic uses header-based auth and
 *     the key never lands in the captured LlmLogEntry today, we assert
 *     `JSON.stringify(entries[0])` does NOT contain the literal apiKey so
 *     a future regression in capture/redaction surfaces immediately.
 *   - The apiKey is read into a local `string | undefined` variable and an
 *     empty-string env var is treated as unset (a CI stub exporting
 *     `ANTHROPIC_API_KEY=` should still skip, not fire a 401).
 *   - When ANTHROPIC_BASE_URL overrides the host, the interceptor's
 *     `providers` filter is computed from the parsed URL hostname so the
 *     captured request still lands in `entries`; the URL assertion is
 *     also derived from the parsed URL components so it stays correct
 *     against any baseUrl.
 */

import { request as httpsRequest } from 'node:https';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

const apiKey: string | undefined = process.env.ANTHROPIC_API_KEY;
const envBaseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL;
const envModel: string | undefined = process.env.ANTHROPIC_MODEL;

const baseUrl: string =
  envBaseUrl !== undefined && envBaseUrl.length > 0
    ? envBaseUrl
    : 'https://api.anthropic.com/v1/messages';
const model: string =
  envModel !== undefined && envModel.length > 0
    ? envModel
    : 'claude-3-5-haiku-20241022';

const parsedUrl = new URL(baseUrl);
const expectedUrlFragment = `${parsedUrl.hostname}${parsedUrl.pathname}`;

const hasKey: boolean = apiKey !== undefined && apiKey.length > 0;

function anthropicLiveSuite(): void {
  test('one real Anthropic Messages call is captured by the interceptor', (done) => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: [parsedUrl.hostname],
      logger: (entry: LlmLogEntry) => entries.push(entry),
    });
    interceptor.install();

    const requestBody = JSON.stringify({
      model: model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const req = httpsRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey ?? '',
          'anthropic-version': '2023-06-01',
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
                expect(entries[0].model).toContain('claude');
                expect(entries[0].inputTokens).toBeGreaterThanOrEqual(0);
                expect(entries[0].outputTokens).toBeGreaterThanOrEqual(0);
                // Defense-in-depth: the captured entry must never echo the
                // API key, even if a future redaction regression puts a
                // header value somewhere it shouldn't be.
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
  describe('anthropic live', anthropicLiveSuite);
} else {
  // Kept out of the default run: no credential, no network egress.
  describe.skip(
    'anthropic live (skip: ANTHROPIC_API_KEY not set)',
    anthropicLiveSuite,
  );
}
