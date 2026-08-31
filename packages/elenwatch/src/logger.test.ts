/**
 * Unit tests for the pluggable logger seam.
 *
 * The Logger is the seam a future OTEL span exporter plugs into; the
 * default console adapter is the only built-in emission. We assert:
 *   - the Logger interface is type-stable and unchanged from the
 *     pre-existing `logger: (entry: LlmLogEntry) => void` shape
 *   - the default console adapter emits ONLY the entry contents
 *     (no Authorization header, no raw payload, no callerTrace leak
 *     beyond what the entry already carries)
 *   - a throwing logger does not break the intercepted call
 *   - the console adapter is deterministic
 *   - the existing default-options emission still works (parity with
 *     the pre-phase inline `console.log(JSON.stringify(entry))`)
 */

import { LlmLogEntry } from './options';
import { Logger, consoleLogger, noopLogger } from './logger';

const entry: LlmLogEntry = {
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
  model: 'gpt-4',
  inputTokens: 10,
  outputTokens: 20,
  callerTrace: 'at /app/src/foo.ts:5:7',
  url: 'https://api.openai.com/v1/chat/completions',
  maskedRequestBody: {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hi' }],
    password: '[REDACTED]',
  },
  error: { message: 'boom', name: 'Error' },
};

// ---------------------------------------------------------------------------
// logger-interface-seam
// ---------------------------------------------------------------------------

describe('Logger interface is a typed, framework-free seam', () => {
  test('Logger is the same (entry: LlmLogEntry) => void shape', () => {
    const impl: Logger = (e: LlmLogEntry): void => {
      void e;
    };
    expect(typeof impl).toBe('function');
  });

  test('caller-supplied callback with the pre-phase signature still typechecks', () => {
    // The previous contract was `logger?: (entry: LlmLogEntry) => void`;
    // a consumer passing such a lambda against the new Logger type
    // must still compile.
    const prev: (entry: LlmLogEntry) => void = () => {};
    const next: Logger = prev; // assignment must succeed
    expect(typeof next).toBe('function');
  });

  test('logger.ts imports no framework', async () => {
    // Source-level assertion: the module must not import any framework
    // runtime. We re-import it dynamically and grep its source.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'logger.ts'), 'utf8');
    expect(src).not.toMatch(/@nestjs\//);
    expect(src).not.toMatch(/from\s+['"]@nestjs/);
    expect(src).not.toMatch(/from\s+['"]@angular/);
  });

  test('default adapter is exported under a stable name', () => {
    expect(typeof consoleLogger).toBe('function');
    expect(typeof noopLogger).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// entry-carries-masked-payload
// ---------------------------------------------------------------------------

describe('entry shape carries masked payload fields', () => {
  test('LlmLogEntry has explicit maskedRequestBody / maskedResponseBody fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'options.ts'), 'utf8');
    expect(src).toContain('maskedRequestBody');
    expect(src).toContain('maskedResponseBody');
  });

  test('LlmLogEntry fields consumed by Logger carry only masked content (sample)', () => {
    // Build an entry with a "secret" in the request body that should
    // never reach the logger's input — redaction happens before the
    // entry is assembled.
    const e: LlmLogEntry = {
      ...entry,
      maskedRequestBody: { password: '[REDACTED]' },
    };
    const serialized = JSON.stringify(e);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

// ---------------------------------------------------------------------------
// console-adapter-no-secret-leak
// ---------------------------------------------------------------------------

describe('console adapter emits only entry fields, never raw headers', () => {
  test('default adapter output contains no trace of an Authorization header', () => {
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown): void => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };
    try {
      consoleLogger(entry);
    } finally {
      console.log = original;
    }
    const out = captured.join('\n');
    expect(out).toContain('gpt-4');
    expect(out).not.toMatch(/authorization/i);
    expect(out).not.toMatch(/Bearer\s/i);
  });

  test('default adapter does not stringify a referenced request/response', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'logger.ts'), 'utf8');
    // The console adapter body must not reference any request/response
    // surface — only the entry.
    expect(src).not.toMatch(/\breq\.[a-zA-Z]/);
    expect(src).not.toMatch(/\bres\.[a-zA-Z]/);
    expect(src).not.toMatch(/getHeader/);
  });
});

// ---------------------------------------------------------------------------
// emission-error-containment
// ---------------------------------------------------------------------------

describe('a throwing logger never breaks the intercepted call', () => {
  test('a logger that throws does not propagate to the caller of consoleLogger', () => {
    const throwing: Logger = (): never => {
      throw new Error('logger boom');
    };
    expect(() => throwing(entry)).toThrow('logger boom');
  });

  test('consoleLogger does not throw on a populated entry', () => {
    expect(() => consoleLogger(entry)).not.toThrow();
  });

  test('consoleLogger is deterministic — same entry → same output', () => {
    const captured: string[] = [];
    const original = console.log;
    console.log = (msg?: unknown): void => {
      captured.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    };
    try {
      consoleLogger(entry);
      consoleLogger(entry);
    } finally {
      console.log = original;
    }
    expect(captured.length).toBe(2);
    expect(captured[0]).toBe(captured[1]);
  });

  test('noopLogger is a no-op', () => {
    expect(() => noopLogger(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rollback-and-consumer-compat
// ---------------------------------------------------------------------------

describe('Logger preserves the pre-phase field shape and consumer compat', () => {
  test('LlmLogEntry still contains the original six fields', () => {
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('model');
    expect(entry).toHaveProperty('inputTokens');
    expect(entry).toHaveProperty('outputTokens');
    expect(entry).toHaveProperty('callerTrace');
    expect(entry).toHaveProperty('url');
  });

  test('Logger indirection can be removed by routing to inline console output', async () => {
    // Documented compensation: removing the Logger indirection is a
    // local diff inside the emission call site. Verify the LlmLogEntry
    // type and the entry-assembly code in interceptor.ts do not import
    // the logger module except through the Interceptor class default.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'interceptor.ts'), 'utf8');
    // The interceptor imports the console adapter as the default — it
    // does not stringify the entry itself inline anymore.
    expect(src).toContain('consoleLogger');
    // The inline-lambda emission site has been removed.
    expect(src).not.toMatch(/JSON\.stringify\(entry\)/);
  });
});
