/**
 * Incremental event-stream (SSE) parser with streaming model/token
 * extraction.
 *
 * This module is the streaming counterpart of `provider-parser.ts`:
 * the buffered path concatenates the whole response body and JSON.parses
 * it once, but a real SSE stream is a sequence of `data:`-line JSON
 * documents that cannot be concatenated. This parser frames those events
 * incrementally — chunk in, event JSON out via a per-event callback —
 * and in the SAME loop keeps running model/token counters, so the caller
 * never needs to retain the stream body.
 *
 * Grammar scope is deliberately NOT full WHATWG SSE: it covers the line
 * shapes the target providers actually emit — `data:` lines (OpenAI
 * chat/completions style, one JSON document per event), `event:` field
 * prefixes (Anthropic Messages style), blank-line event terminators, and
 * a `[DONE]` body. `id:`/`retry:`/multi-line `data:` fields are read but
 * not given streaming semantics; they simply cannot corrupt the parse.
 *
 * Memory contract: the carry holds only the incomplete tail of the
 * current line/event as raw bytes, bounded by the size of one unclosed
 * event, independent of stream length. Each completed event's JSON is
 * decoded exactly once and delivered to the per-event callback, then
 * dropped. Nothing here accumulates the body.
 *
 * Extraction mirrors `defaultParser`'s contract: model from the first
 * event JSON that carries it (OpenAI per-chunk `model`, Anthropic
 * `message_start`), input/output tokens from the terminal usage-bearing
 * event (OpenAI final `usage` chunk, Anthropic `message_delta` usage),
 * falling back to an incremental ceil(chars/4) delta estimate over
 * accumulated delta/replacement text via running counters — never over
 * concatenated text. Pure: never mutates input, never throws on
 * malformed input, falls back to 'unknown'/0.
 */

/** Aggregate extraction result, produced incrementally, never accumulated. */
export interface StreamingResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Number of data-bearing events parsed (blank lines and bare `event:` excluded). */
  eventCount: number;
}

/** Per-event payload handed to the consumer (one SSE `data:` document). */
export interface StreamedEvent {
  /** The event field value if the block carried `event:` (Anthropic style). */
  event?: string;
  /** Raw `data:` line text, exactly as decoded from the wire (never the whole body). */
  data: string;
}

/** Callback receiving each parsed event's JSON document, decoded once. */
export type EventConsumer = (event: StreamedEvent) => void;

interface CarriedState {
  /** Incomplete tail of the current line/event, kept as RAW bytes (never decoded per chunk). */
  tail: Buffer;
  /** `event:` field value of the block currently being assembled. */
  eventType: string;
  /** `data:` field lines accumulated for the current event (bounded, small). */
  dataLines: string[];
  /** Model seen on the earliest event that carried one. */
  model: string;
  /** Input tokens from the first usage-bearing event (OpenAI-style). */
  inputTokens: number;
  /** Output tokens from the first usage-bearing event (Anthropic/OpenAI). */
  outputTokens: number;
  /** Running delta-text estimate, reset to 0 the moment a usage event lands. */
  estimatedOutputTokens: number;
  /** True once a usage-bearing event has landed (authoritative numbers). */
  usageSeen: boolean;
  /** True once the `[DONE]` sentinel has been seen. */
  done: boolean;
  eventCount: number;
  /** Tracked so the total kept in `dataLines` stays small. */
  sawEventField: boolean;
}

const DONE_BODY = '[DONE]';

function freshState(): CarriedState {
  return {
    tail: Buffer.alloc(0),
    eventType: '',
    dataLines: [],
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    estimatedOutputTokens: 0,
    usageSeen: false,
    done: false,
    eventCount: 0,
    sawEventField: false,
  };
}

/** ceil(chars / 4) — mirrors the legacy heuristic. */
function ceilCharsOverFour(text: string): number {
  return Math.ceil(text.length / 4);
}

function readString(obj: unknown, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
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

function readNumber(obj: unknown, ...keys: string[]): number | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  return undefined;
}

function extractUsageNumbers(eventJson: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const record = eventJson as Record<string, unknown> | undefined;
  if (!record || typeof record !== 'object') {
    return {};
  }
  // Anthropic puts input_tokens under message.usage (message_start) and
  // output_tokens under the top-level usage (message_delta); OpenAI puts
  // both under the top-level usage of the final chunk.
  const message = record.message as Record<string, unknown> | undefined;
  const usages = [record.usage, message?.usage].filter(
    (u): u is Record<string, unknown> => Boolean(u) && typeof u === 'object',
  );
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const usage of usages) {
    if (inputTokens === undefined) {
      inputTokens =
        readNumber(usage, 'prompt_tokens') ?? readNumber(usage, 'input_tokens');
    }
    if (outputTokens === undefined) {
      outputTokens =
        readNumber(usage, 'completion_tokens') ??
        readNumber(usage, 'output_tokens');
    }
  }
  return { inputTokens, outputTokens };
}

/** Concatenated delta text of one provider event (choices[].delta / content_block_delta / message). */
function extractDeltaText(eventJson: unknown): string {
  const record = eventJson as Record<string, unknown>;
  if (!record || typeof record !== 'object') {
    return '';
  }
  if (Array.isArray(record.choices)) {
    let text = '';
    for (const choice of record.choices as unknown[]) {
      const c = choice as Record<string, unknown>;
      const delta = c.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === 'string') {
        text += delta.content;
        continue;
      }
      if (typeof c.text === 'string') {
        text += c.text;
      }
    }
    return text;
  }
  if (record.type === 'content_block_delta') {
    const delta = record.delta as Record<string, unknown> | undefined;
    if (
      delta &&
      delta.type === 'text_delta' &&
      typeof delta.text === 'string'
    ) {
      return delta.text;
    }
  }
  if (typeof record.content === 'string') {
    return record.content;
  }
  return '';
}

/** Extract the model from an event JSON (OpenAI per-chunk `model`, Anthropic `message_start`). */
function extractModel(eventJson: unknown, state: CarriedState): void {
  if (state.model !== '') {
    return;
  }
  const model =
    readString(eventJson, 'model', 'model_name') ??
    readString(
      (eventJson as Record<string, unknown> | undefined)?.message,
      'model',
    );
  if (model) {
    state.model = model;
  }
}

function applyUsage(state: CarriedState, eventJson: unknown): void {
  const { inputTokens, outputTokens } = extractUsageNumbers(eventJson);
  if (inputTokens !== undefined) {
    state.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    state.outputTokens = outputTokens;
  }
  if (inputTokens !== undefined || outputTokens !== undefined) {
    // Authoritative numbers have landed; the estimate is superseded.
    state.usageSeen = true;
    state.estimatedOutputTokens = 0;
  }
}

function dispatchEvent(state: CarriedState, consumer: EventConsumer): void {
  const data = state.dataLines.join('\n');
  if (data.length === 0) {
    // An event block with only an event: field and no data: is not a
    // data-bearing event (excluding bare event: prefixes).
    state.dataLines = [];
    state.eventType = '';
    state.sawEventField = false;
    return;
  }
  state.eventCount += 1;
  consumer({ event: state.sawEventField ? state.eventType : undefined, data });
  if (data === DONE_BODY) {
    // The provider sentinel: a data-bearing event, but not a JSON document.
    state.done = true;
  } else {
    let eventJson: unknown;
    try {
      eventJson = JSON.parse(data) as unknown;
    } catch {
      eventJson = undefined;
    }
    if (eventJson !== undefined) {
      extractModel(eventJson, state);
      applyUsage(state, eventJson);
      if (!state.usageSeen) {
        state.estimatedOutputTokens += ceilCharsOverFour(
          extractDeltaText(eventJson),
        );
      }
    }
  }
  state.dataLines = [];
  state.eventType = '';
  state.sawEventField = false;
}

function handleLine(
  state: CarriedState,
  line: string,
  consumer: EventConsumer,
): void {
  if (line === '') {
    // Blank line: end of the current event block.
    dispatchEvent(state, consumer);
    return;
  }
  if (line.startsWith(':')) {
    // SSE comment line.
    return;
  }
  if (line.startsWith('event:')) {
    const value = line.slice('event:'.length);
    if (value.startsWith(' ')) {
      state.eventType = value.slice(1);
    } else {
      state.eventType = value;
    }
    state.sawEventField = true;
    return;
  }
  if (line.startsWith('data:')) {
    const value = line.slice('data:'.length);
    if (value.startsWith(' ')) {
      state.dataLines.push(value.slice(1));
    } else {
      state.dataLines.push(value);
    }
    return;
  }
  // id:/retry:/unknown fields: ignored, cannot corrupt the parse.
}

function extractCompletedLines(state: { tail: Buffer }): string[] {
  const tail = state.tail;
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] === 0x0a /* \n */) {
      let end = i;
      if (end > start && tail[end - 1] === 0x0d /* \r */) {
        end -= 1;
      }
      // Single decode per COMPLETED line: the incomplete tail stays raw
      // bytes, so a multi-byte character split across chunks cannot
      // corrupt (no per-chunk .toString('utf8')).
      lines.push(tail.subarray(start, end).toString('utf8'));
      start = i + 1;
    }
  }
  state.tail = tail.subarray(start);
  return lines;
}

function parseEvents(
  chunkInput: string | Uint8Array | Buffer,
  consumer: EventConsumer,
  carry?: CarriedState,
): StreamingResult {
  const state = carry ?? freshState();
  const chunk =
    typeof chunkInput === 'string'
      ? Buffer.from(chunkInput, 'utf8')
      : Buffer.from(chunkInput as Uint8Array);
  state.tail =
    state.tail.length === 0 ? chunk : Buffer.concat([state.tail, chunk]);
  const lines = extractCompletedLines(state);
  for (const line of lines) {
    handleLine(state, line, consumer);
  }
  return summarize(state);
}

function summarize(state: CarriedState): StreamingResult {
  return {
    model: state.model !== '' ? state.model : 'unknown',
    inputTokens: state.inputTokens,
    outputTokens: state.usageSeen
      ? state.outputTokens
      : state.estimatedOutputTokens,
    eventCount: state.eventCount,
  };
}

/**
 * Create a streaming event parser: feed chunks, receive per-event JSON
 * documents, and query the running aggregate at any point.
 */
export function createEventStreamParser(consumer?: EventConsumer): {
  feed: (chunk: string | Uint8Array | Buffer) => StreamingResult;
  result: () => StreamingResult;
  /** Flush a trailing unterminated event (the stream ended without a final blank line). */
  flush: () => StreamingResult;
  state: () => CarriedState;
} {
  const state = freshState();

  function feed(chunk: string | Uint8Array | Buffer): StreamingResult {
    return parseEvents(chunk, consumer ?? noopConsumer, state);
  }

  function flush(): StreamingResult {
    // A final line without a trailing newline is still a complete event
    // per WHATWG (dispatch on EOF); keep the parsing rules shared. Decode
    // the final line exactly once — never per chunk.
    if (state.tail.length > 0) {
      const finalLine = state.tail.toString('utf8');
      handleLine(
        state,
        finalLine.endsWith('\r') ? finalLine.slice(0, -1) : finalLine,
        consumer ?? noopConsumer,
      );
      state.tail = Buffer.alloc(0);
    }
    dispatchEvent(state, consumer ?? noopConsumer);
    return summarize(state);
  }

  return {
    feed,
    flush,
    result: () => summarize(state),
    state: () => state,
  };
}

function noopConsumer(): void {
  // No-op default: the caller may drive extraction purely via `result()`.
}
