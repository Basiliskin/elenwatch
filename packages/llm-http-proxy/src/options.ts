/**
 * Public option types for the llm-http-proxy interceptor.
 */

/**
 * Shape of the log entry emitted per intercepted LLM call.
 *
 * By default the entry carries NO raw payload: the only payload-related
 * fields are the optional `maskedRequestBody` / `maskedResponseBody` (and
 * the `error` field on the error emission path). The default options never
 * populate the masked-payload fields, so consumers of the default emission
 * never see request/response body content.
 */
export interface LlmLogEntry {
  timestamp: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  callerTrace: string;
  url: string;
  /** Present only when payload capture is explicitly enabled and the body was redactable. */
  maskedRequestBody?: unknown;
  /** Present only when payload capture is explicitly enabled and the body was redactable. */
  maskedResponseBody?: unknown;
  /** Present only on the error emission path. */
  error?: { message: string; name?: string; stack?: string };
}

/**
 * Optional custom token-counting functions. When absent, a simple
 * character-based heuristic is used (ceil(chars / 4)).
 */
export interface TokenCounter {
  estimateInputTokens?: (requestBody: unknown) => number;
  extractOutputTokens?: (responseBody: unknown) => number;
}

/**
 * Interceptor options.
 *
 * `providers` — hostnames (exact or subdomain suffix) or regexes to
 * intercept. Defaults to the common LLM provider hosts.
 *
 * `capturePayloads` — when `false` (default) the emitted entry carries no
 * request/response body; when `true` the captured bodies are included as
 * `maskedRequestBody` / `maskedResponseBody`.
 *
 * `logger` — the emission sink. Defaults to console.log(JSON.stringify(entry)).
 *
 * `tokenCounter` — optional overrides for token estimation/extraction.
 */
export interface InterceptorOptions {
  providers?: (string | RegExp)[];
  capturePayloads?: boolean;
  logger?: (entry: LlmLogEntry) => void;
  tokenCounter?: TokenCounter;
}
