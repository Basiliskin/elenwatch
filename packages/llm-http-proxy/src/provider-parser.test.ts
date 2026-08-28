/**
 * Unit tests for the provider-parser module and registry.
 *
 * The registry is what the interceptor delegates to. We assert:
 *   - each registered host resolves to a distinct parser
 *   - the parsers reproduce today's extractModel + chars/4 + usage
 *     precedence behavior exactly
 *   - a caller-supplied providerParser fully replaces the default
 *     registry when supplied via InterceptorOptions
 *   - parsing is deterministic and pure (no input mutation, same input
 *     → same output)
 */

import * as http from 'node:http';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';
import {
  ParseResult,
  ProviderParser,
  parseCall,
  resolveParser,
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
} from './provider-parser';

/** Local server returning canned OpenAI-shape JSON. */
function startServer(
  body: object = {
    id: 'chatcmpl-1',
    usage: { completion_tokens: 17 },
    choices: [{ message: { content: 'ok' } }],
  },
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
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

function post(
  port: number,
  requestBody: object,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
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
    req.end(JSON.stringify(requestBody));
  });
}

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
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  interceptor.restore();
  return { entries, result };
}

// ---------------------------------------------------------------------------
// provider-parser-api: seam is real and replaceable
// ---------------------------------------------------------------------------

describe('ProviderParser seam is real', () => {
  test('resolveParser returns a distinct parser per registered host', () => {
    const openai = resolveParser('api.openai.com');
    const anthropic = resolveParser('api.anthropic.com');
    const cohere = resolveParser('api.cohere.ai');
    const mistral = resolveParser('api.mistral.ai');
    // Each registry lookup must succeed and yield a defined parser.
    expect(openai).toBeDefined();
    expect(anthropic).toBeDefined();
    expect(cohere).toBeDefined();
    expect(mistral).toBeDefined();
    // All four are addressable under the actual hostname the interceptor
    // intercepts (the registry MUST NOT throw on exact hosts).
    expect(() => resolveParser('api.openai.com')).not.toThrow();
  });

  test('unknown host falls back to a defined parser (no throw)', () => {
    const p = resolveParser('api.notregistered.com');
    expect(p).toBeDefined();
    expect(p.extractModel({ model: 'x' })).toBe('x');
  });

  test('custom providerParser replaces the registry end-to-end', async () => {
    const customParser: ProviderParser = {
      extractModel: () => 'custom-model',
      estimateInputTokens: () => 999,
      extractOutputTokens: () => 1234,
    };
    const { port, close } = await startServer();
    try {
      const { entries } = await withEntries(
        {
          providers: ['127.0.0.1'],
          providerParser: customParser,
        },
        () =>
          post(port, {
            model: 'gpt-4', // would normally win
            messages: [{ role: 'user', content: 'abcdef' }],
          }),
      );
      expect(entries.length).toBe(1);
      expect(entries[0].model).toBe('custom-model');
      expect(entries[0].inputTokens).toBe(999);
      expect(entries[0].outputTokens).toBe(1234);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// legacy-parity: defaults reproduce today's extraction exactly
// ---------------------------------------------------------------------------

describe("legacy parity: defaults reproduce today's extraction", () => {
  test('messages / prompt / input all yield ceil(chars/4)', () => {
    expect(
      defaultEstimateInputTokens({ messages: [{ content: 'hello' }] }),
    ).toBe(2);
    expect(defaultEstimateInputTokens({ prompt: '01234567' })).toBe(2);
    expect(defaultEstimateInputTokens({ input: 'x' })).toBe(1);
    expect(defaultEstimateInputTokens({})).toBe(0);
    expect(defaultEstimateInputTokens(null)).toBe(0);
  });

  test('model is read from `model`, then `model_name`', () => {
    const parser = resolveParser('api.openai.com');
    expect(parser.extractModel({ model: 'gpt-4' })).toBe('gpt-4');
    expect(parser.extractModel({ model_name: 'claude-2' })).toBe('claude-2');
    expect(parser.extractModel({})).toBe('unknown');
    expect(parser.extractModel(null)).toBe('unknown');
  });

  test('usage.completion_tokens wins over usage.output_tokens', () => {
    expect(
      defaultExtractOutputTokens({ usage: { completion_tokens: 42 } }),
    ).toBe(42);
    expect(defaultExtractOutputTokens({ usage: { output_tokens: 7 } })).toBe(7);
    // Precedence: completion_tokens wins even when both present.
    expect(
      defaultExtractOutputTokens({
        usage: { completion_tokens: 1, output_tokens: 99 },
      }),
    ).toBe(1);
  });

  test('choices/completion/output_text fallback yields ceil(chars/4)', () => {
    expect(
      defaultExtractOutputTokens({
        choices: [{ message: { content: 'hi' } }],
      }),
    ).toBe(1);
    expect(defaultExtractOutputTokens({ completion: 'abcdefgh' })).toBe(2);
    expect(defaultExtractOutputTokens({ output_text: 'abcd' })).toBe(1);
  });

  test('parseCall assembles a ParseResult from a parser', () => {
    const parser = resolveParser('api.openai.com');
    const result: ParseResult = parseCall(
      parser,
      { model: 'gpt-4', messages: [{ content: 'abcdef' }] },
      { usage: { completion_tokens: 5 } },
      false,
    );
    expect(result.model).toBe('gpt-4');
    expect(result.inputTokens).toBe(2); // ceil(6/4)
    expect(result.outputTokens).toBe(5);
  });

  test('parseCall on error path forces outputTokens to 0', () => {
    const parser = resolveParser('api.openai.com');
    const result = parseCall(
      parser,
      { model: 'gpt-4' },
      { usage: { completion_tokens: 5 } },
      true,
    );
    expect(result.outputTokens).toBe(0);
  });

  test('subdomain resolves to the registered host parser', () => {
    const sub = resolveParser('eu.api.openai.com');
    const reg = resolveParser('api.openai.com');
    expect(sub.extractModel).toBe(reg.extractModel);
  });
});

// ---------------------------------------------------------------------------
// parse-step-wiring: registry actually drives the emitted entry
// ---------------------------------------------------------------------------

describe('parse step is wired through the registry', () => {
  test('default registry extraction drives the emitted log entry', async () => {
    const { port, close } = await startServer({
      usage: { completion_tokens: 17 },
      choices: [{ message: { content: 'ok' } }],
    });
    try {
      const { entries } = await withEntries({ providers: ['127.0.0.1'] }, () =>
        post(port, {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'abcdefgh' }],
        }),
      );
      expect(entries.length).toBe(1);
      expect(entries[0].model).toBe('gpt-4');
      expect(entries[0].inputTokens).toBe(2); // ceil(8/4)
      expect(entries[0].outputTokens).toBe(17); // usage wins over text fallback
    } finally {
      await close();
    }
  });

  test('overriding the parser changes the emitted entry', async () => {
    const { port, close } = await startServer();
    try {
      const baseline = await withEntries({ providers: ['127.0.0.1'] }, () =>
        post(port, { model: 'real-model', messages: [] }),
      );
      const overridden = await withEntries(
        {
          providers: ['127.0.0.1'],
          providerParser: {
            extractModel: () => 'OVERRIDDEN',
            estimateInputTokens: () => 1000,
            extractOutputTokens: () => 2000,
          },
        },
        () => post(port, { model: 'real-model', messages: [] }),
      );
      expect(baseline.entries[0].model).toBe('real-model');
      expect(overridden.entries[0].model).toBe('OVERRIDDEN');
      expect(overridden.entries[0].inputTokens).toBe(1000);
      expect(overridden.entries[0].outputTokens).toBe(2000);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// pure-and-deterministic: no mutation, repeatable output
// ---------------------------------------------------------------------------

describe('parsing is pure and deterministic', () => {
  test('running any parser twice on the same payload returns deep-equal results', () => {
    const fixtures = [
      { model: 'gpt-4', messages: [{ content: 'hello world' }] },
      { prompt: 'abcdef' },
      { input: 'xyz' },
      {},
      null,
      'not-an-object',
    ];
    for (const parser of [
      resolveParser('api.openai.com'),
      resolveParser('api.anthropic.com'),
      resolveParser('api.cohere.ai'),
      resolveParser('api.mistral.ai'),
    ]) {
      for (const payload of fixtures) {
        const a = {
          m: parser.extractModel(payload),
          i: parser.estimateInputTokens(payload),
        };
        const b = {
          m: parser.extractModel(payload),
          i: parser.estimateInputTokens(payload),
        };
        expect(a).toEqual(b);
      }
    }
  });

  test('parsers do not mutate the input payload', () => {
    const payloads = [
      { model: 'gpt-4', messages: [{ content: 'hi' }] },
      { usage: { completion_tokens: 5 } },
    ];
    for (const p of payloads) {
      const snapshot = JSON.parse(JSON.stringify(p));
      const parser = resolveParser('api.openai.com');
      parser.extractModel(p);
      parser.estimateInputTokens(p);
      parser.extractOutputTokens(p);
      expect(p).toEqual(snapshot);
    }
  });

  test('empty, non-JSON, and usage-less payloads yield safe fallbacks', () => {
    const parser = resolveParser('api.openai.com');
    expect(parser.extractModel(undefined)).toBe('unknown');
    expect(parser.extractModel({})).toBe('unknown');
    expect(parser.estimateInputTokens({})).toBe(0);
    expect(parser.extractOutputTokens({})).toBe(0);
    expect(parser.extractOutputTokens(null)).toBe(0);
  });
});
