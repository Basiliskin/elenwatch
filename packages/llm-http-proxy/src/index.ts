/**
 * llm-http-proxy — near-zero-latency interception of in-process LLM provider
 * HTTP/HTTPS traffic.
 *
 * Public API surface. Later horizons add transformer pipelines and an OTEL
 * span exporter on the logger seam.
 */
export { Interceptor } from './interceptor';
export {
  deriveUrl,
  captureCallerTrace,
  shouldCapture,
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
} from './interceptor';
export type { InterceptorOptions, LlmLogEntry, TokenCounter } from './options';
export const VERSION = '0.1.0';
