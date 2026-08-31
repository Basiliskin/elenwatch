/**
 * global-fetch-capture.integration.test.ts
 *
 * Proof surface for the dual-patch path installed by horizon 9.
 *
 * Fires the user-installed undici's `fetch(...)` against a localhost
 * mock HTTP server and asserts the existing Interceptor captures it
 * via undici's `setGlobalDispatcher` surface (NOT via
 * http.ClientRequest.prototype, which global fetch bypasses in
 * Node 18+; the horizon-7 discovery 'horizon-7-undici-claim-was-wrong'
 * documented this contradiction between the horizon-7 assumption and
 * reality). The fetch call uses `ud.fetch(...)` (the user-undici
 * fetch) rather than `globalThis.fetch` because Jest 29.7.0's lazy
 * loader for globalThis.fetch uses Node's bundled undici separately
 * from any user-installed undici (verified by direct probe under
 * this package's testEnvironment: "node"). In plain Node 22.14, both
 * `globalThis.fetch` and `ud.fetch` exercise the same undici
 * dispatcher wrapper the dual-patch installs; under Jest only
 * `ud.fetch` does. The horizon-8 SDK tests use the explicit-fetch
 * pattern, so the gap is negligible in practice. The dual-patch code
 * itself does not depend on which entry point invoked it.
 *
 * Skip policy: the suite is opt-in to the optional `undici` peer dep
 * (peerDependenciesMeta.undici.optional: true). When the peer is not
 * installed (the default state — undici is NOT a devDependency, by
 * design, to preserve the zero-hard-deps / zero-devDeps-install
 * guarantee), `require('undici')` throws MODULE_NOT_FOUND, the
 * `describe.skip` branch fires, and `npm test` runs in the baseline
 * shape without the suite counting toward failures. To exercise the
 * dual-patch in this file, install undici in the package's
 * node_modules (`npm i -D undici --no-save` — `--no-save` keeps
 * package.json unchanged, honoring the horizon-9 success criterion
 * "packages/llm-http-proxy/package.json's peerDependencies/
 * peerDependenciesMeta unchanged from horizon-9 entries").
 *
 * Test isolation: install/restore are scoped to beforeEach/afterEach
 * so the global-dispatcher mutation caused by `setGlobalDispatcher`
 * cannot leak into sibling test files (notably the fetch-baseline
 * HTTPS suite in this directory, which uses node:https.request and
 * patches via the http.ClientRequest.prototype surface — a different
 * code path that must not be cross-contaminated by an unrestored
 * undici wrapper).
 *
 * Body capture: `ud.fetch(body: 'jsonString')` reaches undici's
 * dispatch() as an AsyncIterable (the dual-patch's discovery entry
 * 'undici-fetch-body-is-async-generator' documented this). The
 * body-capture branch added by the horizon-9 Phase-2 amendment TEES
 * the AsyncIterable into a shared buffer (a single upstream drainer
 * fills sharedChunks; undici's writer and our capture branch both
 * read from it), preventing UND_ERR_REQ_CONTENT_LENGTH_MISMATCH that
 * would otherwise fire from a naïve double-consume. For typical small
 * request payloads (a JSON chat-completions body) the entire payload
 * arrives in one chunk and the drain completes in a microtask before
 * the HTTP lifecycle's onComplete fires. The two-setImmediate flush
 * after `await ud.fetch(...)` covers both the body-drain microtask
 * and the `setImmediate(emitLogEntry)` scheduled by completeCapture on
 * response 'end'.
 *
 * No real credentials: the localhost mock server returns a fixed JSON
 * body; no Authorization / x-api-key / x-goog-api-key header is set.
 * Two-setImmediate flush after `await ud.fetch(...)` lets the body
 * drain and the response 'end' lifecycle settle before the assertions.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

let undici: typeof import('undici') | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  undici = require('undici') as typeof import('undici');
} catch {
  // Peer not installed — leave undefined; the suite registers under
  // describe.skip so the function body never reaches `undici!.getGlobalDispatcher()`.
  undici = undefined;
}

const undiciInstalled: boolean = undici !== undefined;

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

async function startLocalHttpServer(): Promise<RunningServer> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, captured: 'global-fetch' }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error | null) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function globalFetchSuite(ud: typeof import('undici')): void {
  let originalDispatcher: unknown;
  let interceptor: Interceptor | undefined;
  let server: RunningServer | undefined;
  const entries: LlmLogEntry[] = [];

  beforeEach(async () => {
    entries.length = 0;
    // Capture the ORIGINAL dispatcher BEFORE install() so the round-trip
    // identity assertion in afterEach proves restore() reinstalls the
    // EXACT captured reference (=== / .toBe), not a fresh replacement.
    originalDispatcher = ud.getGlobalDispatcher();
    interceptor = new Interceptor({
      providers: [/127\.0\.0\.1|localhost/],
      logger: (entry: LlmLogEntry) => entries.push(entry),
    });
    interceptor.install();
    server = await startLocalHttpServer();
  });

  afterEach(async () => {
    if (interceptor !== undefined) {
      interceptor.restore();
      // Round-trip invariant: after restore, the global dispatcher is
      // back to the captured original BY REFERENCE IDENTITY (.toBe ===)
      // — the same condition installed Interceptor.restore()'s
      // `getGlobalDispatcher() === this.dispatcherWrapper` guard
      // requires (src/interceptor.ts lines 678-680). Failure here proves
      // the undici-patch leaked across tests.
      expect(ud.getGlobalDispatcher()).toBe(originalDispatcher);
      interceptor = undefined;
    }
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  test('undici.fetch is captured via the dual-patch surface and the model is derived from the request body', async () => {
    const targetUrl = server!.url;
    const requestBody = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'hello global fetch' }],
    });

    // We invoke `ud.fetch(...)` (the user-installed undici's fetch)
    // rather than `globalThis.fetch(...)`. Both go through undici's
    // global dispatcher and are wired through the same setGlobalDispatcher
    // route the dual-patch installs. In plain Node 22.14, globalThis.fetch
    // routes through user-undici's fetchImpl and DOES exercise the wrapper
    // (verified by manual probe). Under Jest 29.7.0, globalThis.fetch
    // lazy-loads Node's bundled undici via the bootstrap's lazy-loader
    // and does NOT share state with user-installed undici, so the
    // wrapper is bypassed. The horizon's success criterion aims to prove
    // "the dual-patch captures fetch traffic" — calling `ud.fetch(...)`
    // exercises the same code path that the Vercel AI SDK providers
    // (horizon 8) take when they accept a `fetch` callback, and is the
    // SAME code path that globalThis.fetch takes in plain Node. Calling
    // it explicitly here makes the test environment-portable.
    await ud.fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
    // Two setImmediate ticks so the AsyncGenerator body drain (microtask
    // after dispatch() returns) and the response 'end' lifecycle (which
    // schedules emitLogEntry on a setImmediate from completeCapture)
    // both settle before the assertions.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Exactly one entry was emitted via the undici-patch surface.
    expect(entries.length).toBe(1);
    const entry = entries[0];
    // LlmLogEntry shape fields populated from the undici-routed request.
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.url).toBe(targetUrl);
    expect(typeof entry.callerTrace).toBe('string');
    // Model derived from the captured REQUEST body (the AsyncGenerator
    // drain populates state.requestBodyChunks so defaultParser.extractModel
    // sees `requestJson.model` and returns 'claude-3-5-haiku-20241022').
    expect(entry.model).toBe('claude-3-5-haiku-20241022');
    expect(typeof entry.inputTokens).toBe('number');
    expect(typeof entry.outputTokens).toBe('number');

    // Follow-up fetch under the still-installed interceptor: afterEach's
    // restore() is the round-trip boundary. We do NOT issue a second
    // fetch here — the round-trip is proven by the afterEach assertion
    // (`expect(ud.getGlobalDispatcher()).toBe(originalDispatcher)`).
  }, 60000);
}

if (undiciInstalled && undici !== undefined) {
  describe('global fetch capture (undici-patch surface)', () => {
    globalFetchSuite(undici);
  });
} else {
  describe.skip(
    'global fetch capture (skip: undici peer not installed — install undici@^6 to exercise the dual-patch)',
    globalFetchSuitePlaceholder,
  );
}

// Standalone function so describe.skip compiles even when undici is absent:
// the suite body uses `ud.getGlobalDispatcher()` which would not type-check
// without a non-null assertion outside the `undiciInstalled` branch.
function globalFetchSuitePlaceholder(): void {
  test('placeholder; the real suite needs undici installed', () => {
    expect(undiciInstalled).toBe(false);
  });
}
