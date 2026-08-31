/**
 * OpenTelemetry span exporter adapter for the Logger seam.
 *
 * The exporter turns each LlmLogEntry into an OpenTelemetry span. It is
 * strictly opt-in: the @opentelemetry/* packages are optional peer
 * dependencies and are loaded lazily inside a try/catch — when the
 * peers are not installed, this module is a non-throwing no-op.
 *
 * A top-level static import of `@opentelemetry/api` would pass every
 * local gate (the peer is installed for development) while silently
 * breaking opt-in activation for any consumer without the peer. The
 * peer is therefore resolved exactly once at module load, and the rest
 * of the module references the resolved handle through a captured
 * reference rather than re-importing.
 *
 * Span attributes are derived exclusively from the LlmLogEntry fields.
 * The package's core redaction invariant — no raw payload, no headers
 * in any emitted log entry or span — is preserved by construction: only
 * fields on the already-redacted entry are ever read.
 */

import type { Logger } from './logger';
import type { LlmLogEntry } from './options';
import { peerRequire } from './peer-require';

// Resolve the peer once at module load via `peerRequire`, which works in
// both the CJS and the ESM build (a bare `require` here would throw
// `require is not defined` under ESM and be misread as "peer absent"). The
// cast to the imported type lets the rest of the file use real types so the
// no-unsafe-* lint rules do not fire on `any`.
type OtelApi = typeof import('@opentelemetry/api');

interface OtelHandle {
  readonly trace: OtelApi['trace'];
  readonly SpanStatusCode: OtelApi['SpanStatusCode'];
}

let otel: OtelHandle | undefined;
try {
  const mod = peerRequire('@opentelemetry/api') as OtelApi;
  otel = { trace: mod.trace, SpanStatusCode: mod.SpanStatusCode };
} catch {
  // Peers not installed — leave `otel` undefined so calls below are inert.
  otel = undefined;
}

const TRACER_NAME = 'elenwatch';
const SPAN_NAME = 'elenwatch.llm-call';

/**
 * A Logger-compatible OpenTelemetry span exporter.
 *
 * When the optional `@opentelemetry/api` peer is installed, each call
 * records exactly one span named `elenwatch.llm-call` on a tracer
 * named `elenwatch`, with start time taken from `entry.timestamp`
 * and attributes copied exclusively from the entry's fields. The span
 * is always ended, including on the error path.
 *
 * When the peer is absent, this is a non-throwing no-op.
 */
export const otelSpanLogger: Logger = (entry: LlmLogEntry): void => {
  if (otel === undefined) {
    return;
  }
  const tracer = otel.trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(SPAN_NAME, { startTime: entry.timestamp });
  try {
    span.setAttribute('model', entry.model);
    span.setAttribute('inputTokens', entry.inputTokens);
    span.setAttribute('outputTokens', entry.outputTokens);
    span.setAttribute('callerTrace', entry.callerTrace);
    span.setAttribute('url', entry.url);
    if (entry.maskedRequestBody !== undefined) {
      span.setAttribute(
        'maskedRequestBody',
        JSON.stringify(entry.maskedRequestBody),
      );
    }
    if (entry.maskedResponseBody !== undefined) {
      span.setAttribute(
        'maskedResponseBody',
        JSON.stringify(entry.maskedResponseBody),
      );
    }
    if (entry.error !== undefined) {
      span.recordException(new Error(entry.error.message));
      span.setStatus({
        code: otel.SpanStatusCode.ERROR,
        message: entry.error.message,
      });
    }
  } finally {
    span.end();
  }
};
