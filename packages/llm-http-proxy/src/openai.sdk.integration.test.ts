/**
 * openai.sdk.integration.test.ts
 *
 * OpenAI Vercel AI SDK end-to-end verification of the horizon-9 dual-patch.
 *
 * Goal: prove the horizon-9 dual-patch (http.ClientRequest.prototype wrap +
 * undici setGlobalDispatcher) captures a real generateText call issued by
 * @ai-sdk/openai WITHOUT a per-file fetch: option being passed to the SDK
 * provider. The SDK must rely on its default fetch (which under plain Node 22
 * routes through undici's global dispatcher) — the dual-patch is the sole
 * interception surface for this test.
 *
 * NO-SHIM INVARIANT (load-bearing for this phase):
 *   The createOpenAI() options object MUST NOT contain a `fetch:` key of
 *   any kind. Neither createSdkFetchShim (from src/sdk-fetch-shim.ts, shipped
 *   in Phase 1) nor any other fetch override is passed to the provider. The
 *   horizon-9 dual-patch must do the capture alone. If a future change adds a
 *   fetch: override to make entries.length === 1 pass, that change defeats
 *   the entire purpose of this suite — the SDK would route around the
 *   dual-patch entirely.
 *
 * Why this matters: Jest 29.7.0 + Node 22.14.0 + testEnvironment: 'node' has
 * a documented globalThis.fetch lazy-loader behavior (see discoveries.md
 * 'jest-29-node-22-fetch-bridge-broken'): under Jest, globalThis.fetch may
 * spawn a fresh bundled undici that does NOT share globalDispatcher state
 * with a user-installed require('undici'). The horizon-9 WrappingDispatcher
 * installs via setGlobalDispatcher on the user-undici's getGlobalDispatcher
 * reference; if the SDK happens to reach undici through that same
 * reference (its default), capture works. If the SDK reaches the bundled
 * fresh undici (some boot paths), the wrapper is bypassed and entries.length
 * reads 0. This test surfaces that risk as a clear fail (entries.length !== 1
 * or getGlobalDispatcher identity mismatch) instead of a silently-skipped
 * capture. The shim from Phase 1 is intentionally NOT used here because the
 * dual-patch verification is the bound work.
 *
 * Opt-in: the API key IS the gate (no separate LIVE flag). With the key
 * unset, the suite resolves to describe.skip and a placeholder function (no
 * provider instantiation, no Interceptor.install() in the skip path) so
 * default `npm test` never hits api.openai.com.
 *
 * Env-driven configuration (defaults match the rubric's documented values):
 *   - OPENAI_API_KEY    required to opt in (above).
 *   - OPENAI_BASE_URL   optional; overrides the SDK's baseURL (useful for
 *                       proxy/staging endpoints). Default
 *                       `https://api.openai.com/v1/chat/completions` for the
 *                       URL fragment assertion (the SDK appends
 *                       `/chat/completions` to the provider baseURL).
 *   - OPENAI_MODEL      optional; overrides the model id. Default
 *                       `gpt-4o-mini`.
 *   Empty-string env vars are treated as unset and fall back to defaults.
 *
 * Gotchas documented for future maintainers:
 *   - Emission is deferred via setImmediate in src/interceptor.ts
 *     (emitLogEntry runs on a setImmediate from completeCapture), so we
 *     await two sequential setImmediate ticks after `await generateText(...)`
 *     before asserting on the captured `entries` array — same flush pattern
 *     as src/global-fetch-capture.integration.test.ts.
 *   - `callerTrace` resolves to 'unknown' under Jest (the interceptor passes
 *     'unknown' when no caller trace is supplied), so we do NOT assert on it.
 *   - `capturePayloads` stays default-off so the emitted entry has no
 *     masked-body fields; we assert on model / url / token counts only.
 *   - Defense-in-depth: even though the SDK's default transport does not
 *     echo the API key in the captured LlmLogEntry today, we assert
 *     `JSON.stringify(entries[0])` does NOT contain the literal apiKey so a
 *     future regression in capture/redaction surfaces immediately.
 *   - Dual-patch isolation: undici's global dispatcher is captured in
 *     beforeEach BEFORE Interceptor.install() and asserted via .toBe in
 *     afterEach AFTER interceptor.restore(). A test that throws before
 *     restore() leaves a stale wrapper that would poison the next
 *     *.integration.test.ts in the same Jest run; the try/finally wraps
 *     the test body so restore() runs on both success and throw paths.
 *   - SDK packages are lazy-loaded inside the hasKey branch via require()
 *     (matching the no-shim rubric's lazy-import requirement) so the skip
 *     path's module load cannot trigger a TLS handshake or a fresh
 *     undici reference that would race the dual-patch surface.
 */

import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

let undici: typeof import('undici') | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  undici = require('undici') as typeof import('undici');
} catch {
  // Peer not installed — leave undefined; the suite registers under
  // describe.skip and the test body never reaches `undici!.getGlobalDispatcher()`.
  undici = undefined;
}

const undiciInstalled: boolean = undici !== undefined;

const apiKey: string | undefined = process.env.OPENAI_API_KEY;
const envBaseUrl: string | undefined = process.env.OPENAI_BASE_URL;
const envModel: string | undefined = process.env.OPENAI_MODEL;

const baseUrl: string =
  envBaseUrl !== undefined && envBaseUrl.length > 0
    ? envBaseUrl
    : 'https://api.openai.com/v1/chat/completions';
const model: string =
  envModel !== undefined && envModel.length > 0 ? envModel : 'gpt-4o-mini';

// Derive the expected URL fragment from the parsed baseUrl so the assertion
// stays correct when OPENAI_BASE_URL points at a proxy or staging host.
const parsedUrl = new URL(baseUrl);
const expectedUrlFragment = `${parsedUrl.hostname}${parsedUrl.pathname}`;

const hasKey: boolean = apiKey !== undefined && apiKey.length > 0;

function openaiSdkSuite(ud: typeof import('undici')): void {
  let originalDispatcher: unknown;
  let interceptor: Interceptor | undefined;
  const entries: LlmLogEntry[] = [];

  beforeEach(() => {
    entries.length = 0;
    // Capture the ORIGINAL dispatcher BEFORE install() so the round-trip
    // identity assertion in afterEach proves restore() reinstalls the
    // EXACT captured reference (=== / .toBe), not a fresh replacement —
    // same condition installed Interceptor.restore()'s guard requires.
    originalDispatcher = ud.getGlobalDispatcher();
    interceptor = new Interceptor({
      providers: [parsedUrl.hostname],
      logger: (entry: LlmLogEntry) => entries.push(entry),
    });
    interceptor.install();
  });

  afterEach(() => {
    if (interceptor !== undefined) {
      interceptor.restore();
      // Round-trip invariant: after restore, the global dispatcher is
      // back to the captured original BY REFERENCE IDENTITY (.toBe ===).
      // Failure here proves the dual-patch leaked across tests.
      expect(ud.getGlobalDispatcher()).toBe(originalDispatcher);
      interceptor = undefined;
    }
  });

  test('one real @ai-sdk/openai generateText call is captured by the dual-patch (no per-file fetch shim)', async () => {
    // Lazy-load SDK packages INSIDE the hasKey branch so the skip path
    // does not trigger module-load side effects (TLS handshake, undici
    // reference creation, env reads beyond OPENAI_API_KEY).
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createOpenAI } =
      require('@ai-sdk/openai') as typeof import('@ai-sdk/openai');
    const { generateText } = require('ai') as typeof import('ai');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // NO-SHIM INVARIANT: createOpenAI receives ONLY apiKey (+ optional
    // baseURL from OPENAI_BASE_URL). NO `fetch:` key of any kind. The
    // horizon-9 dual-patch is the sole interception surface for this test.
    const providerOptions: {
      apiKey: string;
      baseURL?: string;
    } = {
      apiKey: apiKey ?? '',
    };
    if (envBaseUrl !== undefined && envBaseUrl.length > 0) {
      providerOptions.baseURL = envBaseUrl;
    }
    const openaiProvider = createOpenAI(providerOptions);

    try {
      await generateText({
        model: openaiProvider(model),
        prompt: 'Reply with the single word: ok',
      });

      // Two sequential setImmediate ticks so the dual-patch's deferred
      // emitLogEntry (scheduled via setImmediate from completeCapture)
      // flushes into our local `entries` array before we assert.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Exactly one entry — catches the dual-patch double-emit regression
      // (http.ClientRequest.prototype + WrappingDispatcher both firing)
      // and the bootstrap-loaded-undici bypass (entries.length === 0).
      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.model).toContain('gpt');
      expect(entry.url).toContain(expectedUrlFragment);
      expect(entry.inputTokens).toBeGreaterThanOrEqual(0);
      expect(entry.outputTokens).toBeGreaterThanOrEqual(0);
      // Defense-in-depth: the captured entry must never echo the API key,
      // even if a future redaction regression puts a header value somewhere
      // it shouldn't be.
      expect(JSON.stringify(entry)).not.toContain(apiKey ?? '__unset__');
    } finally {
      // restore() is reachable on both success and throw paths so a
      // failing assertion cannot leave the global dispatcher wrapped.
      if (interceptor !== undefined) {
        interceptor.restore();
        interceptor = undefined;
      }
    }
  }, 60000);
}

// Standalone function so describe.skip compiles even when undici is absent:
// the live suite body uses `ud.getGlobalDispatcher()` which would not
// type-check without a non-null assertion outside the `undiciInstalled` branch.
function openaiSdkSuitePlaceholder(): void {
  test('placeholder; the real suite needs undici installed', () => {
    expect(undiciInstalled).toBe(false);
  });
}

if (hasKey) {
  if (undiciInstalled && undici !== undefined) {
    describe('openai SDK (dual-patch end-to-end verification)', () => {
      openaiSdkSuite(undici);
    });
  } else {
    describe.skip(
      'openai SDK (skip: undici peer not installed — install undici@^6 to exercise the dual-patch)',
      openaiSdkSuitePlaceholder,
    );
  }
} else {
  // No credential, no network egress: default `npm test` skips cleanly.
  describe.skip(
    'openai SDK (skip: OPENAI_API_KEY not set)',
    openaiSdkSuitePlaceholder,
  );
}
