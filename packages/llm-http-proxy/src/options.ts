/**
 * Public option types for the llm-http-proxy interceptor.
 */

import type { Logger } from './logger';
import type { ProviderParser } from './provider-parser';
import type { RedactionConfig } from './redaction';

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
 * character-based heuristic is used (ceil(chars / 4)). Prefer supplying
 * a `providerParser` over these — the parser owns the full extraction
 * contract and these legacy hooks are kept only for backward compat.
 */
export interface TokenCounter {
  estimateInputTokens?: (requestBody: unknown) => number;
  extractOutputTokens?: (responseBody: unknown) => number;
}

/**
 * Request-body transformer (first slice, horizon 3).
 *
 * Receives the fully concatenated captured request body as a UTF-8 string
 * and returns the body to send on the wire. Must be synchronous. Returning
 * `undefined` (or the input unchanged) is passthrough: the original body is
 * kept and Content-Length is NOT rewritten. MUST NOT throw; a throwing
 * transformer forwards the body unchanged. Contract pinned by
 * docs/roadmaps/llm-http-proxy/transformer-slice-spec.md.
 */
export type RequestTransformer = (requestBody: string) => string | undefined;

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
 *
 * `providerParser` — optional per-host parser that fully overrides the
 * default registry's model and token extraction. When supplied, the
 * registry is bypassed entirely.
 *
 * `redaction` — optional configuration for payload redaction. The
 * default config masks built-in PII / credential / financial field names
 * on both request and response sides. Override to add custom field
 * names or to limit masking to one side.
 *
 * `requestTransform` — optional request-body transformer. Runs exactly
 * once per request body, between chunk capture and wire forwarding;
 * absent option = synchronous passthrough (unchanged behavior).
 */
export interface InterceptorOptions {
  providers?: (string | RegExp)[];
  capturePayloads?: boolean;
  logger?: Logger;
  tokenCounter?: TokenCounter;
  providerParser?: ProviderParser;
  redaction?: RedactionConfig;
  requestTransform?: RequestTransformer;
}
