/**
 * elenwatch — near-zero-latency interception of in-process LLM provider
 * HTTP/HTTPS traffic.
 *
 * Public API surface. Later horizons add transformer pipelines and an OTEL
 * span exporter on the logger seam.
 */
export { Interceptor } from './interceptor';
export { deriveUrl, captureCallerTrace, shouldCapture } from './interceptor';
export {
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
  defaultParser,
} from './provider-parser';
export type { ProviderParser, ParseResult } from './provider-parser';
export {
  redact,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SENSITIVE_FIELDS,
  DEFAULT_REDACTION_CONFIG,
} from './redaction';
export type { RedactionConfig } from './redaction';
export { consoleLogger, noopLogger } from './logger';
export type { Logger } from './logger';
export { otelSpanLogger } from './otel';
export type {
  InterceptorOptions,
  LlmLogEntry,
  TokenCounter,
  RequestTransformer,
  ResponseTransformer,
} from './options';
export const VERSION = '0.2.0';
