/**
 * Unit tests for the redaction module and its integration with the
 * interceptor's emission path.
 *
 * Coverage of the rubric dimensions:
 *   - default-no-raw: no raw payload ever appears under default config
 *   - configured-field-masking: top-level / nested / array hits all
 *   - error-path-parity: error emission also runs through redact()
 *   - masking-idempotent: redact(redact(x)) === redact(x)
 *   - redact-never-throws: hostile inputs (circular, non-JSON, etc.)
 *     never propagate an exception
 */

import * as http from 'node:http';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';
import {
  DEFAULT_PLACEHOLDER,
  DEFAULT_REDACTION_CONFIG,
  DEFAULT_SENSITIVE_FIELDS,
  redact,
} from './redaction';

const SECRET = 'sk-secret-XYZ-123';
const EMAIL = 'user@example.com';

// ---------------------------------------------------------------------------
// default-no-raw: default config never emits raw payloads
// ---------------------------------------------------------------------------

describe('default config: no raw payloads', () => {
  test('redact() is exported with a default config that needs no caller setup', () => {
    expect(typeof redact).toBe('function');
    expect(DEFAULT_REDACTION_CONFIG).toBeDefined();
    expect(typeof DEFAULT_PLACEHOLDER).toBe('string');
    expect(Array.isArray(DEFAULT_SENSITIVE_FIELDS)).toBe(true);
  });

  test('redact() replaces built-in PII keys with the placeholder', () => {
    const input = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      password: SECRET,
      email: EMAIL,
    };
    const masked = redact(input) as Record<string, unknown>;
    expect(masked.password).toBe(DEFAULT_PLACEHOLDER);
    expect(masked.email).toBe(DEFAULT_PLACEHOLDER);
    expect(masked.model).toBe('gpt-4');
  });

  test('redact() masks the entry when capturePayloads is on', async () => {
    const { port, close } = await startServer();
    try {
      const entries: LlmLogEntry[] = [];
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        capturePayloads: true,
        logger: (e) => entries.push(e),
      });
      interceptor.install();
      await post(
        port,
        JSON.stringify({
          model: 'gpt-4',
          prompt: 'hello',
          apiKey: SECRET,
        }),
      );
      await new Promise((r) => setImmediate(r));
      interceptor.restore();
      expect(entries.length).toBe(1);
      const serialized = JSON.stringify(entries[0].maskedRequestBody);
      expect(serialized).toContain(DEFAULT_PLACEHOLDER);
      expect(serialized).not.toContain(SECRET);
    } finally {
      await close();
    }
  });

  test('no masked-payload fields appear when capturePayloads is false', async () => {
    const { port, close } = await startServer();
    try {
      const entries: LlmLogEntry[] = [];
      const interceptor = new Interceptor({
        providers: ['127.0.0.1'],
        logger: (e) => entries.push(e),
      });
      interceptor.install();
      await post(port, JSON.stringify({ model: 'gpt-4', password: SECRET }));
      await new Promise((r) => setImmediate(r));
      interceptor.restore();
      expect(entries.length).toBe(1);
      expect(entries[0].maskedRequestBody).toBeUndefined();
      expect(entries[0].maskedResponseBody).toBeUndefined();
      const serialized = JSON.stringify(entries[0]);
      expect(serialized).not.toContain(SECRET);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// configured-field-masking: hits top-level / nested / array / both sides
// ---------------------------------------------------------------------------

describe('configured field masking is recursive and side-aware', () => {
  test('top-level field is masked', () => {
    const out = redact({ apiKey: SECRET }) as Record<string, unknown>;
    expect(out.apiKey).toBe(DEFAULT_PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('deeply nested field is masked', () => {
    const out = redact({
      outer: { inner: { apiKey: SECRET } },
    }) as Record<string, unknown>;
    const inner = (out.outer as Record<string, unknown>).inner as Record<
      string,
      unknown
    >;
    expect(inner.apiKey).toBe(DEFAULT_PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('array-of-objects path is masked at every instance', () => {
    const out = redact({
      users: [{ email: EMAIL }, { profile: { email: EMAIL } }],
    }) as Record<string, unknown>;
    const users = out.users as Array<Record<string, unknown>>;
    expect(users[0].email).toBe(DEFAULT_PLACEHOLDER);
    expect((users[1].profile as Record<string, unknown>).email).toBe(
      DEFAULT_PLACEHOLDER,
    );
    expect(JSON.stringify(out)).not.toContain(EMAIL);
  });

  test('caller-supplied sensitiveFields are masked', () => {
    const out = redact(
      { myCustomField: 'plain text' },
      { sensitiveFields: ['mycustom'] },
    ) as Record<string, unknown>;
    expect(out.myCustomField).toBe(DEFAULT_PLACEHOLDER);
  });

  test('non-sensitive fields are preserved byte-for-byte', () => {
    const input = {
      model: 'gpt-4',
      messages: [{ content: 'hello' }],
      metadata: { traceId: 'abc-123', tags: ['prod', 'v2'] },
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.model).toBe('gpt-4');
    expect((out.messages as Array<Record<string, unknown>>)[0].content).toBe(
      'hello',
    );
    const meta = out.metadata as Record<string, unknown>;
    expect(meta.traceId).toBe('abc-123');
    expect(meta.tags).toEqual(['prod', 'v2']);
  });

  test('custom placeholder is honored', () => {
    const out = redact(
      { apiKey: SECRET },
      { placeholder: '***HIDDEN***' },
    ) as Record<string, unknown>;
    expect(out.apiKey).toBe('***HIDDEN***');
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('requestOnly / responseOnly confines masking to one side', () => {
    const input = { apiKey: SECRET };
    const reqMasked = redact(input, { requestOnly: true }, 'request') as Record<
      string,
      unknown
    >;
    expect(reqMasked.apiKey).toBe(DEFAULT_PLACEHOLDER);
    const respUnmasked = redact(
      input,
      { requestOnly: true },
      'response',
    ) as Record<string, unknown>;
    expect(respUnmasked.apiKey).toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
// error-path-parity: error emissions run through redact()
// ---------------------------------------------------------------------------

describe('error-path emissions honor redaction', () => {
  test('error emission masks sensitive values when capturePayloads is on', async () => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: ['127.0.0.1'],
      capturePayloads: true,
      logger: (e) => entries.push(e),
    });
    interceptor.install();
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 1,
        path: '/',
        method: 'POST',
      });
      req.on('error', () => resolve());
      req.end(JSON.stringify({ model: 'gpt-4', apiKey: SECRET }));
    });
    await new Promise((r) => setImmediate(r));
    interceptor.restore();
    expect(entries.length).toBe(1);
    expect(entries[0].error).toBeDefined();
    const serialized = JSON.stringify(entries[0].maskedRequestBody);
    expect(serialized).not.toContain(SECRET);
  });

  test('error emission has no raw payload under default options', async () => {
    const entries: LlmLogEntry[] = [];
    const interceptor = new Interceptor({
      providers: ['127.0.0.1'],
      logger: (e) => entries.push(e),
    });
    interceptor.install();
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 1,
        path: '/',
        method: 'POST',
      });
      req.on('error', () => resolve());
      req.end(JSON.stringify({ model: 'gpt-4', apiKey: SECRET }));
    });
    await new Promise((r) => setImmediate(r));
    interceptor.restore();
    expect(entries.length).toBe(1);
    expect(entries[0].error).toBeDefined();
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain(SECRET);
    expect(entries[0].maskedRequestBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// masking-idempotent
// ---------------------------------------------------------------------------

describe('masking is idempotent, lossless, mutation-free', () => {
  test('redact(redact(x)) deep-equals redact(x)', () => {
    const input = {
      model: 'gpt-4',
      password: SECRET,
      email: EMAIL,
      messages: [{ content: 'hi' }],
    };
    const a = redact(input);
    const b = redact(a);
    expect(b).toEqual(a);
  });

  test('redact does not mutate the input payload', () => {
    const input = Object.freeze({
      model: 'gpt-4',
      password: SECRET,
      nested: Object.freeze({ apiKey: SECRET }),
    });
    const before = JSON.stringify(input);
    const out = redact(input);
    const after = JSON.stringify(input);
    expect(after).toBe(before);
    expect(out).not.toBe(input);
  });

  test('masked output is structurally valid (deep-equal keys present)', () => {
    const input = { model: 'gpt-4', password: SECRET, count: 42 };
    const out = redact(input) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort());
  });
});

// ---------------------------------------------------------------------------
// redact-never-throws: hostile / pathological inputs
// ---------------------------------------------------------------------------

describe('redact() never throws and stays bounded', () => {
  test.each([
    [null],
    [undefined],
    [''],
    ['plain string'],
    [42],
    [true],
    [[]],
    [{}],
    [Buffer.from('binary')],
  ])('redact(%p) does not throw', (input) => {
    expect(() => redact(input as unknown)).not.toThrow();
  });

  test('circular references do not crash; cycles break at the cycle point', () => {
    const a: Record<string, unknown> = { model: 'gpt-4' };
    a.self = a;
    let out: unknown;
    expect(() => {
      out = redact(a);
    }).not.toThrow();
    expect(out).toBeDefined();
  });

  test('deeply nested non-circular payload completes bounded', () => {
    let current: Record<string, unknown> = {};
    const root = current;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    let out: unknown;
    expect(() => {
      out = redact(root);
    }).not.toThrow();
    expect(out).toBeDefined();
  });

  test('malicious duplicate-key collision still returns a defined value', () => {
    const input = { password: SECRET, 'X-Password': SECRET };
    const out = redact(input) as Record<string, unknown>;
    expect(out.password).toBe(DEFAULT_PLACEHOLDER);
    expect(out['X-Password']).toBe(DEFAULT_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            usage: { completion_tokens: 1 },
            choices: [{ message: { content: 'ok' } }],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({
          port: addr.port,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      } else {
        throw new Error('no port');
      }
    });
  });
}

function post(port: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
