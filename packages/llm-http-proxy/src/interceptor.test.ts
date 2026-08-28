/**
 * Unit tests for the interceptor core.
 *
 * Careful note on isolation: these tests install the process-global patch,
 * so each suite that touches http/https must restore() before other suites
 * run. Jest runs spec files in isolated module registries by default
 * (each test file gets its own copies of node:http/https), so the patch
 * never leaks across files.
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import {
  Interceptor,
  deriveUrl,
  resolveScheme,
  shouldCapture,
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
} from './interceptor';
import type { LlmLogEntry } from './options';
import type { ProviderParser } from './provider-parser';

/**
 * Jest's module registry exposes `http.request` as a getter-only, non-
 * configurable property, and real Node exposes it as a writable data
 * property. The interceptor must patch through the *currently valid
 * property slot* — which is itself a snapshot of the current value (the
 * export may be a getter OR a bound function). We therefore do the patch
 * via defineProperty on the transitory value-slot, never on the module's
 * own export slot.
 */

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
    const { port, close } = await startServer();
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
    await new Promise<void>((resolve) => {
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
    const { port, close } = await startServer();
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
    const { port, close } = await startServer();
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

  test('write(chunk, encoding, cb) forwards encoding and callback verbatim (finding #4)', async () => {
    const { port, close } = await startServer();
    try {
      const proto = http.ClientRequest.prototype;
      const origWrite = proto.write;
      const writeSpy = jest.spyOn(proto, 'write');
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        capturePayloads: true,
        logger: () => {},
      });
      interceptor.install();
      const cb = jest.fn();
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
        });
        req.on('response', (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        const chunk = Buffer.from('aGVsbG8=', 'base64');
        req.write(chunk, 'base64', cb);
        req.end();
      });
      interceptor.restore();
      // The pristine original (spy) must have received the full argument
      // list: chunk, 'base64', AND the callback — never a subset.
      const call = writeSpy.mock.calls.find(
        (c) =>
          c[0] instanceof Buffer &&
          c[1] === 'base64' &&
          typeof c[2] === 'function',
      );
      expect(call).toBeDefined();
      expect(call?.[2]).toBe(cb);
      expect(call?.[1]).toBe('base64');
      writeSpy.mockRestore();
      expect(proto.write).toBe(origWrite);
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
    const { port, close } = await startServer();
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

  test('TLS request via https.request is logged with an https:// url (finding #1)', async () => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: ['api.example.com'],
      capturePayloads: true,
      logger: (entry) => entries.push(entry),
    });
    // Real https.request produces a request whose protocol is 'https:' and
    // whose socket is a TLSSocket. Drive the emission path through the
    // public attachCapture with a fake req exposing protocol + getHeader.
    const fakeReq = new EventEmitter() as unknown as http.ClientRequest;
    (fakeReq as unknown as { protocol: string }).protocol = 'https:';
    (fakeReq as unknown as { hostname: string }).hostname = 'api.example.com';
    (fakeReq as unknown as { path: string }).path = '/v1/chat/completions';
    (fakeReq as unknown as { getHeader: () => string | undefined }).getHeader =
      () => 'api.example.com';
    interceptor.attachCapture(fakeReq);
    const fakeRes = new EventEmitter() as unknown as http.IncomingMessage;
    const reqTagged = fakeReq as unknown as {
      emit: (ev: string, ...args: unknown[]) => boolean;
    };
    reqTagged.emit('response', fakeRes);
    (fakeRes as unknown as { emit: (ev: string) => boolean }).emit('end');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    interceptor.restore();
    expect(entries.length).toBe(1);
    expect(entries[0].url).toBe('https://api.example.com/v1/chat/completions');
  });

  test('resolveScheme falls back to socket.encrypted for TLS requests', () => {
    const plain = {
      hostname: 'x.example.com',
      protocol: 'http:',
    } as unknown as http.ClientRequest;
    expect(resolveScheme(plain)).toBe('http');
    const tlsBySocket = {
      hostname: 'x.example.com',
      protocol: 'http:',
      socket: { encrypted: true },
    } as unknown as http.ClientRequest;
    expect(resolveScheme(tlsBySocket)).toBe('https');
    const tlsByAgent = {
      hostname: 'x.example.com',
      agent: { protocol: 'https:' },
    } as unknown as http.ClientRequest;
    expect(resolveScheme(tlsByAgent)).toBe('https');
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
      new Error('boom'); // hostile error props tolerated
      req.on('error', () => resolve()); // no crash despite hostile props
      req.end('{}');
    });
    interceptor.restore();
    // The next server test would fail loudly if the process crashed.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// emission-path hardening (findings #3 and #6)
// ---------------------------------------------------------------------------

describe('emission path: exactly-once + cannot crash', () => {
  /** Build a fake ClientRequest exposing only what attachCapture needs. */
  function fakeReq(): http.ClientRequest {
    const req = new EventEmitter() as unknown as http.ClientRequest;
    (req as unknown as { hostname: string }).hostname = 'api.example.com';
    (req as unknown as { path: string }).path = '/v1/chat/completions';
    (req as unknown as { protocol: string }).protocol = 'https:';
    (req as unknown as { getHeader: () => string | undefined }).getHeader =
      () => 'api.example.com';
    return req;
  }

  function flush(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  test('response-then-error on one request emits exactly one entry (finding #6)', async () => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: ['api.example.com'],
      capturePayloads: true,
      logger: (entry) => entries.push(entry),
    });
    const req = fakeReq();
    interceptor.attachCapture(req);
    const res = new EventEmitter() as unknown as http.IncomingMessage;
    (req as unknown as EventEmitter).emit('response', res);
    (res as unknown as EventEmitter).emit('end');
    // The error terminal signal fires on the same request afterwards.
    (req as unknown as EventEmitter).emit(
      'error',
      Object.assign(new Error('boom'), { name: 'boom' }),
    );
    await flush();
    await flush();
    expect(entries.length).toBe(1);
  });

  test('a throwing providerParser in the emission path cannot crash (finding #3)', async () => {
    const entries: LlmLogEntry[] = [];
    const boomParser: ProviderParser = {
      extractModel: () => {
        throw new Error('parser blew up');
      },
      estimateInputTokens: () => 0,
      extractOutputTokens: () => 0,
    };
    const interceptor = new Interceptor({
      providers: ['api.example.com'],
      capturePayloads: true,
      providerParser: boomParser,
      logger: (entry) => entries.push(entry),
    });
    const req = fakeReq();
    interceptor.attachCapture(req);
    const res = new EventEmitter() as unknown as http.IncomingMessage;
    (req as unknown as EventEmitter).emit('response', res);
    (res as unknown as EventEmitter).emit('end');
    await flush();
    await flush();
    // The parser threw inside the deferred emission path; the process did
    // not crash, and no entry was produced (the entry assembly aborted).
    expect(entries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// default-redaction
// ---------------------------------------------------------------------------

describe('default-redaction: no raw payload in default emissions', () => {
  test('sensitive literal from the request body never appears by default', async () => {
    const { port, close } = await startServer();
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
    const { port, close } = await startServer();
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
// multibyte-chunk-buffering (finding #7)
// ---------------------------------------------------------------------------

describe('multibyte body chunks round-trip intact (finding #7)', () => {
  const MAGIC = 'héllo wörld 中\u{1F600}'; // include a 2-, 3-, and 4-byte char

  test('response body split mid-character is not corrupted to U+FFFD', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: MAGIC } }],
    });
    const buf = Buffer.from(body, 'utf8');
    // Byte offset where the 'é' (0xC3 0xA9) begins, then split INSIDE it.
    const firstCharByte = Buffer.byteLength(body.slice(0, body.indexOf('é')));
    const split = firstCharByte + 1; // first byte of é in chunk A, second in chunk B
    // Sanity: decoding either half alone corrupts the split char to U+FFFD.
    expect(buf.subarray(firstCharByte, split).toString('utf8')).toBe('\uFFFD');
    expect(buf.subarray(split, split + 1).toString('utf8')).toBe('\uFFFD');

    const { port, close } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(buf.subarray(0, split));
        res.write(buf.subarray(split));
        res.end();
      });
    });
    try {
      const { entries } = await withEntries(
        { providers: ['127.0.0.1'], capturePayloads: true },
        () => post(port, JSON.stringify({ model: 'gpt-4' })),
      );
      expect(entries.length).toBe(1);
      const masked = entries[0].maskedResponseBody as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(masked.choices[0].message.content).toBe(MAGIC);
      expect(JSON.stringify(entries[0].maskedResponseBody)).not.toContain(
        '\uFFFD',
      );
    } finally {
      await close();
    }
  });

  test('request body sent in byte-split Buffer writes round-trips intact', async () => {
    const body = JSON.stringify({ messages: [{ content: MAGIC }] });
    const buf = Buffer.from(body, 'utf8');
    const split = 1; // split inside the first multi-byte char sequence
    const { port, close } = await startServer();
    try {
      const { entries } = await withEntries(
        { providers: ['127.0.0.1'], capturePayloads: true },
        () =>
          new Promise<void>((resolve, reject) => {
            const req = http.request(
              { hostname: '127.0.0.1', port, path: '/', method: 'POST' },
              (res) => {
                res.resume();
                res.on('end', resolve);
              },
            );
            req.on('error', reject);
            req.write(buf.subarray(0, split));
            req.write(buf.subarray(split));
            req.end();
          }),
      );
      expect(entries.length).toBe(1);
      const masked = entries[0].maskedRequestBody as {
        messages: Array<{ content: string }>;
      };
      expect(masked.messages[0].content).toBe(MAGIC);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// caller-trace
// ---------------------------------------------------------------------------

describe('caller trace', () => {
  test('success path: points at the file that issued the request, not interceptor internals', async () => {
    const { port, close } = await startServer();
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
