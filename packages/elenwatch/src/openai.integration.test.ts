/**
 * openai.integration.test.ts
 *
 * Live OpenAI Chat Completions smoke test — opt-in only.
 *
 * Goal: prove the in-process interceptor captures a real OpenAI
 * Chat Completions call end-to-end when OPENAI_API_KEY is present in the
 * environment.
 *
 * Opt-in: the API key IS the gate (no separate LIVE flag). With the key
 * unset, the suite resolves to `describe.skip` so the default `npm test`
 * never hits api.openai.com. Per the horizon-7 decision, a separate
 * LIVE flag would fail-not-skip when set without the key, so we deliberately
 * do not introduce one.
 *
 * Env-driven configuration (defaults match the rubric's documented values):
 *   - OPENAI_API_KEY    required to opt in (above)
 *   - OPENAI_BASE_URL   optional; overrides the request target (useful
 *                       for proxy/staging endpoints). Default
 *                       `https://api.openai.com/v1/chat/completions`.
 *   - OPENAI_MODEL      optional; overrides the model id (useful for
 *                       pinning model-version). Default `gpt-4o-mini`.
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
 *   - Defense-in-depth: even though OpenAI uses header-based auth and
 *     the key never lands in the captured LlmLogEntry today, we assert
 *     `JSON.stringify(entries[0])` does NOT contain the literal apiKey so
 *     a future regression in capture/redaction surfaces immediately.
 *   - The apiKey is read into a local `string | undefined` variable and an
 *     empty-string env var is treated as unset.
 *   - When OPENAI_BASE_URL overrides the host, the interceptor's
 *     `providers` filter is computed from the parsed URL hostname so the
 *     captured request still lands in `entries`; the URL assertion is
 *     also derived from the parsed URL components so it stays correct
 *     against any baseUrl.
 */

import { request as httpsRequest } from 'node:https';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

const apiKey: string | undefined = process.env.OPENAI_API_KEY;
const envBaseUrl: string | undefined = process.env.OPENAI_BASE_URL;
const envModel: string | undefined = process.env.OPENAI_MODEL;

const baseUrl: string =
  envBaseUrl !== undefined && envBaseUrl.length > 0
    ? envBaseUrl
    : 'https://api.openai.com/v1/chat/completions';
const model: string =
  envModel !== undefined && envModel.length > 0 ? envModel : 'gpt-4o-mini';

const parsedUrl = new URL(baseUrl);
const expectedUrlFragment = `${parsedUrl.hostname}${parsedUrl.pathname}`;

const hasKey: boolean = apiKey !== undefined && apiKey.length > 0;

function openaiLiveSuite(): void {
  test('one real OpenAI Chat Completions call is captured by the interceptor', (done) => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: [parsedUrl.hostname],
      logger: (entry: LlmLogEntry) => entries.push(entry),
    });
    interceptor.install();

    const requestBody = JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    });

    const req = httpsRequest(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey ?? ''}`,
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
                expect(entries[0].model).toContain('gpt');
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
  describe('openai live', openaiLiveSuite);
} else {
  // Kept out of the default run: no credential, no network egress.
  describe.skip('openai live (skip: OPENAI_API_KEY not set)', openaiLiveSuite);
}
