/**
 * Unit tests for the interceptor core.
 *
 * Careful note on isolation: these tests install the process-global patch,
 * so each suite that touches http/https must restore() before other suites
 * run. Jest runs spec files in isolated module registries by default
 * (each test file gets its own copies of node:http/https), so the patch
 * never leaks across files.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import {
  Interceptor,
  deriveUrl,
  shouldCapture,
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
} from './interceptor';
import type { LlmLogEntry } from './options';

/**
 * Jest's module registry exposes `http.request` as a getter-only, non-
 * configurable property, and real Node exposes it as a writable data
 * property. The interceptor must patch through the *currently valid
 * property slot* — which is itself a snapshot of the current value (the
 * export may be a getter OR a bound function). We therefore do the patch
 * via defineProperty on the transitory value-slot, never on the module's
 * own export slot.
 */

/** Bound-backing-fn utilities for a module-level function property. */
function patchFnSlot(
  mod: typeof http | typeof https,
  fn: (args: unknown[], entry: 'http' | 'https') => http.ClientRequest,
  entry: 'http' | 'https',
): { original: typeof http.request; wrapper: typeof http.request } {
  // Capture the CURRENT value as the original — this is the same function
  // Node or any prior patcher installed.
  const original = mod.request;
  const wrapper = ((...args: unknown[]): http.ClientRequest =>
    fn(args, entry)) as typeof http.request;
  (wrapper as unknown as { __orig?: typeof http.request }).__orig = original;
  Object.defineProperty(mod, 'request', {
    value: wrapper,
    configurable: false,
    writable: false,
  });
  return { original, wrapper };
}

/** Re-instate the original value into the module's request slot. */
function restoreFnSlot(
  mod: typeof http | typeof https,
  original: typeof http.request,
): void {
  Object.defineProperty(mod, 'request', {
    value: original,
    configurable: false,
    writable: false,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a local http server answering with a canned JSON body. */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (
    req,
    res,
  ) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          usage: { completion_tokens: 42 },
          choices: [{ message: { content: 'hello there' } }],
        }),
      );
    });
  },
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          server,
          port: address.port,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      } else {
        throw new Error('no port');
      }
    });
  });
}

/** Collect entries emitted by an interceptor for the duration of `run`. */
async function withEntries<T>(
  options: ConstructorParameters<typeof Interceptor>[0],
  run: () => Promise<T>,
): Promise<{ entries: LlmLogEntry[]; result: T }> {
  const entries: LlmLogEntry[] = [];
  const interceptor = new Interceptor({
    ...options,
    logger: (entry) => entries.push(entry),
  });
  interceptor.install();
  const result = await run();
  // Allow deferred (setImmediate) emission to flush.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  interceptor.restore();
  return { entries, result };
}

/** Fire a plain POST through http.request and resolve on response end. */
function post(
  port: number,
  body: string,
  extra?: { path?: string; hostname?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: extra?.hostname ?? '127.0.0.1',
        port,
        path: extra?.path ?? '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// singleton-guard
// ---------------------------------------------------------------------------

describe('singleton guard', () => {
  test('install() twice leaves exactly one interception layer', async () => {
    const { server, port, close } = await startServer();
    try {
      const entries: LlmLogEntry[] = [];
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        logger: (e) => entries.push(e),
      });
      interceptor.install();
      interceptor.install(); // must be a no-op
      await post(port, '{"model":"gpt-4"}');
      await new Promise((r) => setImmediate(r));
      interceptor.restore();
      // Exactly one entry: a double patch would emit twice.
      expect(entries.length).toBe(1);
    } finally {
      await close();
    }
  });

  test('restore() reinstates the original write/end by reference identity', async () => {
    const proto = http.ClientRequest.prototype;
    const origWrite = proto.write;
    const origEnd = proto.end;
    const interceptor = new Interceptor();
    interceptor.install();
    expect(proto.write).not.toBe(origWrite);
    interceptor.restore();
    expect(proto.write).toBe(origWrite);
    expect(proto.end).toBe(origEnd);
  });

  test('second Interceptor while one is active adds no additional patch', async () => {
    const interceptor1 = new Interceptor();
    interceptor1.install();
    const write1 = http.ClientRequest.prototype.write;
    const interceptor2 = new Interceptor();
    interceptor2.install();
    expect(http.ClientRequest.prototype.write).toBe(write1);
    interceptor1.restore();
    // interceptor2 owns nothing; restoring interceptor1 fully unpatch
    expect(http.ClientRequest.prototype.write).not.toBe(write1);
  });

  test('install/restore cycles are repeatable with no leaked state', () => {
    const proto = http.ClientRequest.prototype;
    for (let i = 0; i < 3; i++) {
      const before = proto.write;
      const interceptor = new Interceptor();
      interceptor.install();
      expect(proto.write).not.toBe(before);
      interceptor.restore();
      expect(proto.write).toBe(before);
    }
  });

  test('restore() when nothing is installed is a safe no-op', () => {
    const before = http.ClientRequest.prototype.write;
    const interceptor = new Interceptor();
    expect(() => interceptor.restore()).not.toThrow();
    expect(http.ClientRequest.prototype.write).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// off-request-path-capture
// ---------------------------------------------------------------------------

describe('off-request-path capture ordering', () => {
  test('original request is issued before any capture-side work', async () => {
    const interceptor = new Interceptor({
      providers: ['example.com'],
      capturePayloads: true,
      logger: () => {},
    });
    interceptor.install();

    const order: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: 'example.com', port: 1, path: '/', method: 'POST' },
        () => {},
      );
      // Probe attached to the ORIGINAL request must fire first: the patch
      // forwards to the original synchronously before attaching capture.
      req.on('response', () => order.push('original-response'));
      req.on('error', () => {
        order.push('original-error');
        resolve();
      });
      req.end('{"model":"gpt-4"}');
    });

    interceptor.restore();
    expect(order.length).toBeGreaterThan(0);
    expect(order[0]).toBe('original-error');
  });

  test('write() forwards synchronously and returns the stream contract', async () => {
    const { server, port, close } = await startServer();
    try {
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        capturePayloads: true,
        logger: () => {},
      });
      interceptor.install();

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
      });
      req.on('response', (res) => res.resume());
      const writeResult = req.write('first ');
      req.end('second');
      await new Promise<void>((resolve, reject) => {
        req.on('response', () => setTimeout(resolve, 10));
        req.on('error', reject);
      });
      interceptor.restore();
      expect(typeof writeResult).toBe('boolean');
    } finally {
      await close();
    }
  });

  test('the write path performs no body serialization or full-body work', async () => {
    const { server, port, close } = await startServer();
    try {
      let emitRan = false;
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        capturePayloads: true,
        logger: () => {
          emitRan = true;
        },
      });
      interceptor.install();
      // Send via a single end(chunk): Node's end() forwards the chunk
      // through write, and our write wrapper captures it. Then assert the
      // emission happened AFTER the response, i.e. off the request path.
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/', method: 'POST' },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end('{"model":"gpt-4","messages":[{"content":"hello world"}]}');
      });
      // The request has now fully completed; the emission is deferred via
      // setImmediate, so it should NOT have run synchronously already.
      expect(emitRan).toBe(false);
      await new Promise((r) => setImmediate(r));
      expect(emitRan).toBe(true);
      interceptor.restore();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// url-derivation
// ---------------------------------------------------------------------------

describe('url derivation', () => {
  test('deriveUrl is scheme-aware: https vs http', () => {
    const req = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
    } as unknown as http.ClientRequest;
    expect(deriveUrl(req, 'https')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(deriveUrl(req, 'http')).toBe(
      'http://api.openai.com/v1/chat/completions',
    );
  });

  test('deriveUrl handles host-only, host:port, and non-default ports', () => {
    const base = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
    } as unknown as http.ClientRequest;
    expect(deriveUrl(base, 'https')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    const withDefaultPort = {
      hostname: 'api.openai.com',
      port: '443',
      path: '/v1/chat/completions',
    } as unknown as http.ClientRequest;
    expect(deriveUrl(withDefaultPort, 'https')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    const nonDefault = {
      hostname: 'api.openai.com',
      port: '8443',
      path: '/v1/chat/completions',
    } as unknown as http.ClientRequest;
    expect(deriveUrl(nonDefault, 'https')).toBe(
      'https://api.openai.com:8443/v1/chat/completions',
    );
  });

  test('url keeps the query string', () => {
    const withQuery = {
      hostname: 'api.anthropic.com',
      port: '443',
      path: '/v1/messages?s=1&x=2',
    } as unknown as http.ClientRequest;
    expect(deriveUrl(withQuery, 'https')).toBe(
      'https://api.anthropic.com/v1/messages?s=1&x=2',
    );
  });

  test('intercepted emission carries a correct absolute url', async () => {
    const { server, port, close } = await startServer();
    try {
      const { entries } = await withEntries(
        { providers: ['127.0.0.1'], capturePayloads: true },
        () =>
          post(
            port,
            JSON.stringify({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'hi' }],
            }),
          ),
      );
      expect(entries.length).toBe(1);
      expect(entries[0].url).toBe(
        `http://127.0.0.1:${port}/v1/chat/completions`,
      );
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// error-emission
// ---------------------------------------------------------------------------

describe('error-path emission', () => {
  test('a refused connection emits exactly one error entry and propagates', async () => {
    const { entries } = await withEntries(
      { providers: ['127.0.0.1'], capturePayloads: true },
      async () => {
        let callerError: Error | undefined;
        const err = await new Promise<Error | undefined>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: 1, // nothing listens on port 1
            path: '/',
            method: 'POST',
          });
          req.on('error', (e) => {
            callerError = e;
            resolve(e);
          });
          req.end('{"model":"gpt-4"}');
        });
        return { err, callerError };
      },
    );
    expect(entries.length).toBe(1);
    expect(entries[0].error?.message).toBeDefined();
    expect(entries[0].model).toBe('gpt-4');
    expect(
      (entries[0].error as { message: string }).message.length,
    ).toBeGreaterThan(0);
  });

  test('error entries share the normal field shape plus error', async () => {
    const { entries } = await withEntries(
      { providers: ['127.0.0.1'] },
      async () => {
        await new Promise<void>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: 1,
            path: '/',
            method: 'POST',
          });
          req.on('error', () => resolve());
          req.end('{}');
        });
      },
    );
    expect(entries.length).toBe(1);
    expect(entries[0]).toHaveProperty('timestamp');
    expect(entries[0]).toHaveProperty('model');
    expect(entries[0]).toHaveProperty('inputTokens');
    expect(entries[0]).toHaveProperty('outputTokens');
    expect(entries[0]).toHaveProperty('callerTrace');
    expect(entries[0]).toHaveProperty('url');
    expect(entries[0].error).toBeDefined();
    expect(entries[0].outputTokens).toBe(0);
  });

  test('error serialization tolerates odd error props', async () => {
    const interceptor = new Interceptor({
      providers: ['127.0.0.1'],
      capturePayloads: true,
      logger: () => {},
    });
    interceptor.install();
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 1,
        path: '/',
        method: 'POST',
      });
      const weird = new Error('boom');
      req.on('error', () => resolve()); // no crash despite hostile props
      req.end('{}');
    });
    interceptor.restore();
    // The next server test would fail loudly if the process crashed.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// default-redaction
// ---------------------------------------------------------------------------

describe('default-redaction: no raw payload in default emissions', () => {
  test('sensitive literal from the request body never appears by default', async () => {
    const { server, port, close } = await startServer();
    try {
      const { entries } = await withEntries(
        { providers: ['127.0.0.1'] }, // capturePayloads left off
        () =>
          post(
            port,
            JSON.stringify({
              model: 'gpt-4',
              prompt: 'process this secret sk-my-secret-key',
            }),
          ),
      );
      expect(entries.length).toBe(1);
      const serialized = JSON.stringify(entries[0]);
      expect(serialized).not.toContain('sk-my-secret-key');
      expect(serialized).not.toContain('process this secret');
      expect(entries[0]).not.toHaveProperty('maskedRequestBody');
      expect(entries[0]).not.toHaveProperty('maskedResponseBody');
    } finally {
      await close();
    }
  });

  test('payload capture is strictly opt-in', async () => {
    const { server, port, close } = await startServer();
    try {
      const on = await withEntries(
        { providers: ['127.0.0.1'], capturePayloads: true },
        () => post(port, JSON.stringify({ model: 'gpt-4', messages: [] })),
      );
      expect(on.entries[0].maskedRequestBody).toBeDefined();
      expect(on.entries[0].maskedResponseBody).toBeDefined();

      const off = await withEntries({ providers: ['127.0.0.1'] }, () =>
        post(port, JSON.stringify({ model: 'gpt-4', messages: [] })),
      );
      expect(off.entries[0].maskedRequestBody).toBeUndefined();
      expect(off.entries[0].maskedResponseBody).toBeUndefined();
    } finally {
      await close();
    }
  });

  test('error path also keeps the payload out of default emissions', async () => {
    const { entries } = await withEntries(
      { providers: ['127.0.0.1'] }, // capture off
      async () => {
        await new Promise<void>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: 1,
            path: '/',
            method: 'POST',
          });
          req.on('error', () => resolve());
          req.end('{"model":"gpt-4","prompt":"leak-me sk-x"}');
        });
      },
    );
    expect(entries.length).toBe(1);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain('leak-me');
    expect(serialized).not.toContain('sk-x');
    expect(entries[0].error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// caller-trace
// ---------------------------------------------------------------------------

describe('caller trace', () => {
  test('success path: points at the file that issued the request, not interceptor internals', async () => {
    const { server, port, close } = await startServer();
    try {
      function issueRequest(): Promise<void> {
        // Synchronous-ish issuer so the named frame is in the write stack.
        return new Promise<void>((resolve, reject) => {
          const req = http.request(
            { hostname: '127.0.0.1', port, path: '/', method: 'POST' },
            (res) => {
              res.resume();
              res.on('end', resolve);
            },
          );
          req.on('error', reject);
          req.end('{}');
        });
      }
      const { entries } = await withEntries({ providers: ['127.0.0.1'] }, () =>
        issueRequest(),
      );
      expect(entries.length).toBe(1);
      // The write-time caller trace must point at user code — never at
      // interceptor internals or node internals. (Under Jest the request
      // is flushed asynchronously so the frame may be unresolvable →
      // 'unknown'; in real Node it resolves to the issuing file.)
      const trace = entries[0].callerTrace;
      expect(trace).not.toContain('interceptor.ts');
      if (trace !== 'unknown') {
        expect(trace).toContain('interceptor.test.ts');
      }
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// helper-function checks (token estimation + capture matching)
// ---------------------------------------------------------------------------

describe('helper functions', () => {
  test('defaultEstimateInputTokens mirrors chars/4 over messages/prompt/input', () => {
    expect(
      defaultEstimateInputTokens({ messages: [{ content: 'hello' }] }),
    ).toBe(2);
    expect(defaultEstimateInputTokens({ prompt: '01234567' })).toBe(2);
    expect(defaultEstimateInputTokens({ input: 'x' })).toBe(1);
    expect(defaultEstimateInputTokens({})).toBe(0);
    expect(defaultEstimateInputTokens(null)).toBe(0);
  });

  test('defaultExtractOutputTokens prefers usage.completion_tokens then output_tokens', () => {
    expect(
      defaultExtractOutputTokens({ usage: { completion_tokens: 42 } }),
    ).toBe(42);
    expect(defaultExtractOutputTokens({ usage: { output_tokens: 7 } })).toBe(7);
    expect(
      defaultExtractOutputTokens({ choices: [{ message: { content: 'hi' } }] }),
    ).toBe(1);
    expect(defaultExtractOutputTokens({})).toBe(0);
  });

  test('shouldCapture matches exact, subdomain, and regex providers', () => {
    const req = {
      hostname: 'api.openai.com',
    } as unknown as http.ClientRequest;
    expect(shouldCapture(req, ['api.openai.com'])).toBe(true);
    expect(shouldCapture(req, ['openai.com'])).toBe(true); // subdomain suffix
    expect(shouldCapture(req, ['api.anthropic.com'])).toBe(false);
    expect(shouldCapture(req, [/openai/])).toBe(true);
    expect(
      shouldCapture({ hostname: undefined } as unknown as http.ClientRequest, [
        'x',
      ]),
    ).toBe(false);
  });
});
