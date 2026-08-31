/**
 * Proof tests for the OpenTelemetry span exporter (src/otel.ts).
 *
 * Two behaviors are verified in the default `npm test` (no env flag):
 *   1. With the optional peers installed, an LlmLogEntry becomes exactly
 *      one finished span on a real InMemorySpanExporter, with attributes
 *      and start time matching the entry field-for-field.
 *   2. With the optional peers absent (simulated via jest.doMock +
 *      jest.isolateModules), the exporter is a non-throwing no-op.
 *
 * These run in the default suite so the OTEL demo's bar stays
 * authoritative: every `npm test` green light means the demo works.
 *
 * The peers-absent test loads src/otel.ts inside jest.isolateModules so
 * its top-level `require('@opentelemetry/api')` re-runs against a
 * throwing mock — that is what exercises the catch branch. Loading the
 * module outside the isolated registry would return the already-cached,
 * peers-present binding and silently pass even if the try/catch were
 * broken.
 */

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { otelSpanLogger } from './otel';
import type { LlmLogEntry } from './options';

const sampleEntry: LlmLogEntry = {
  timestamp: new Date('2026-08-30T12:34:56.789Z'),
  model: 'gpt-proof-1',
  inputTokens: 42,
  outputTokens: 17,
  callerTrace: 'trace-proof-abc-123',
  url: 'https://api.example.com/v1/chat',
  maskedRequestBody: { messages: [{ role: 'user', content: '[REDACTED]' }] },
  maskedResponseBody: { id: 'resp-proof-1', choices: [] },
  error: { message: 'rate-limited', name: 'RateLimitError' },
};

describe('otelSpanLogger', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // In @opentelemetry/sdk-trace-base v2.x the TracerProvider exposes
    // spanProcessors via the constructor only — there is no public
    // addSpanProcessor method. Passing it here registers the in-memory
    // exporter for every span the provider's tracer starts.
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it('with peers present: records exactly one span whose attributes and start time come from the entry', () => {
    otelSpanLogger(sampleEntry);

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);

    const span = finished[0];
    expect(span.name).toBe('elenwatch.llm-call');
    expect(span.attributes.model).toBe('gpt-proof-1');
    expect(span.attributes.inputTokens).toBe(42);
    expect(span.attributes.outputTokens).toBe(17);
    expect(span.attributes.callerTrace).toBe('trace-proof-abc-123');
    expect(span.attributes.url).toBe('https://api.example.com/v1/chat');
    expect(span.attributes.maskedRequestBody).toBe(
      JSON.stringify({ messages: [{ role: 'user', content: '[REDACTED]' }] }),
    );
    expect(span.attributes.maskedResponseBody).toBe(
      JSON.stringify({ id: 'resp-proof-1', choices: [] }),
    );

    // startTime is HrTime = [seconds, nanos]; compare via epoch ms.
    const startMs =
      span.startTime[0] * 1000 + Math.floor(span.startTime[1] / 1e6);
    expect(startMs).toBe(sampleEntry.timestamp.getTime());

    // Error path: span records the error and is closed (otherwise
    // SimpleSpanProcessor would not have surfaced it via getFinishedSpans).
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('rate-limited');
    expect(span.events.length).toBeGreaterThanOrEqual(1);
  });

  it('with peers absent: is a non-throwing no-op (try/catch feature detection)', () => {
    jest.isolateModules(() => {
      jest.doMock('@opentelemetry/api', () => {
        throw new Error('peer not installed');
      });
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const mod = require('./otel') as typeof import('./otel');

      expect(() => mod.otelSpanLogger(sampleEntry)).not.toThrow();
      expect(() => mod.otelSpanLogger(sampleEntry)).not.toThrow();
    });
  });
});
