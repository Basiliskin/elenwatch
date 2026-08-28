/**
 * Parsing: model + token extraction behind a pluggable seam.
 *
 * The `ProviderParser` interface is what the interceptor's parse step
 * delegates to. `defaultParser` below reproduces today's behavior
 * exactly (model from `model` then `model_name`; input = ceil(chars/4)
 * over messages/prompt/input; output = usage.completion_tokens preferred
 * over usage.output_tokens, with the choices/completion/output_text
 * text fallback). Consumers can supply a custom parser via the
 * `providerParser` option and the interceptor will use it in full.
 *
 * Parsers MUST be pure: same input → same output, no mutation of the
 * payload, fall back to 'unknown'/0 on malformed input rather than
 * throwing. The redaction/transform pipeline runs after the parse step
 * and assumes an untouched payload.
 */

/** A pluggable parser for one provider's request/response shape. */
export interface ProviderParser {
  /** Extract the model name from a parsed request body. */
  extractModel(requestJson: unknown): string;
  /** Estimate input tokens for a parsed request body. */
  estimateInputTokens(requestJson: unknown): number;
  /** Extract output tokens from a parsed response body. */
  extractOutputTokens(responseJson: unknown): number;
}

/** Result of running the parser over a captured request/response pair. */
export interface ParseResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read a string field from an unknown object, with safe fallbacks. */
function readString(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string') {
      return v;
    }
  }
  return undefined;
}

/** Pull text from messages/prompt/input for the chars/4 input heuristic. */
function readInputText(requestJson: unknown): string {
  const obj = requestJson as Record<string, unknown> | undefined;
  if (!obj) {
    return '';
  }
  if (Array.isArray(obj.messages)) {
    return obj.messages
      .map((m) => {
        const message = m as Record<string, unknown>;
        return typeof message.content === 'string' ? message.content : '';
      })
      .join(' ');
  }
  if (typeof obj.prompt === 'string') {
    return obj.prompt;
  }
  if (typeof obj.input === 'string') {
    return obj.input;
  }
  return '';
}

/** ceil(chars / 4) — the legacy token heuristic. */
function ceilCharsOverFour(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * usage.completion_tokens (OpenAI) wins over usage.output_tokens
 * (Anthropic). Returns 0 when neither is present.
 */
function readUsageTokens(responseJson: unknown): number | undefined {
  const obj = responseJson as Record<string, unknown> | undefined;
  if (!obj) {
    return undefined;
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }
  if (typeof usage.completion_tokens === 'number') {
    return usage.completion_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    return usage.output_tokens;
  }
  return undefined;
}

/** Pull text from choices/completion/output_text for the legacy fallback. */
function readOutputText(responseJson: unknown): string {
  const obj = responseJson as Record<string, unknown> | undefined;
  if (!obj) {
    return '';
  }
  if (Array.isArray(obj.choices)) {
    return obj.choices
      .map((c) => {
        const choice = c as Record<string, unknown>;
        const message = choice.message as Record<string, unknown> | undefined;
        if (typeof message?.content === 'string') {
          return message.content;
        }
        return typeof choice.text === 'string' ? choice.text : '';
      })
      .join(' ');
  }
  if (typeof obj.completion === 'string') {
    return obj.completion;
  }
  if (typeof obj.output_text === 'string') {
    return obj.output_text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Default parser
// ---------------------------------------------------------------------------

/**
 * The single default parser: OpenAI / Anthropic / Cohere / Mistral all
 * share the same shape contract, so one parser replaces the former
 * per-provider registry. A caller-supplied `providerParser` option fully
 * replaces it.
 */
export const defaultParser: ProviderParser = {
  extractModel: (requestJson) =>
    readString(requestJson, 'model', 'model_name') ?? 'unknown',
  estimateInputTokens: (requestJson) =>
    ceilCharsOverFour(readInputText(requestJson)),
  extractOutputTokens: (responseJson) => {
    const usage = readUsageTokens(responseJson);
    return usage !== undefined
      ? usage
      : ceilCharsOverFour(readOutputText(responseJson));
  },
};

/** Run a parser over a captured request/response and assemble a ParseResult. */
export function parseCall(
  parser: ProviderParser,
  requestJson: unknown,
  responseJson: unknown,
  isError: boolean,
): ParseResult {
  return {
    model: parser.extractModel(requestJson),
    inputTokens: parser.estimateInputTokens(requestJson),
    outputTokens: isError ? 0 : parser.extractOutputTokens(responseJson),
  };
}

/**
 * Default input-token heuristic: ceil(chars / 4) over the messages/prompt/
 * input text. Mirrors the original implementation.
 */
export function defaultEstimateInputTokens(requestJson: unknown): number {
  return ceilCharsOverFour(readInputText(requestJson));
}

/**
 * Default output-token extraction: OpenAI usage.completion_tokens wins over
 * Anthropic usage.output_tokens; falls back to ceil(chars / 4) over the
 * choices/completion/output_text content.
 */
export function defaultExtractOutputTokens(responseJson: unknown): number {
  const usage = readUsageTokens(responseJson);
  return usage !== undefined
    ? usage
    : ceilCharsOverFour(readOutputText(responseJson));
}
