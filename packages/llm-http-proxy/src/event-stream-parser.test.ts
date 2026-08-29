/**
 * Tests for the incremental event-stream parser.
 *
 * Covers the two target provider grammars (OpenAI chat/completions-style
 * and Anthropic Messages event:-prefixed), cross-chunk integrity (every-byte
 * splits, mid multi-byte characters), the bounded-capture memory contract,
 * purity/no-throw contract, and the usage-wins-else-incremental-char-estimate
 * extraction rules.
 */

import { Buffer } from 'node:buffer';
import {
  createEventStreamParser,
  type EventConsumer,
  type StreamingResult,
} from './event-stream-parser';

/** OpenAI chat/completions-style transcript (docs-faithful, terminal usage chunk + [DONE]). */
function openAiTranscript(): string {
  const lines = [
    'data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7,"total_tokens":49}}',
    '',
    'data: [DONE]',
    '',
  ];
  return lines.join('\n');
}

/** Anthropic Messages-style transcript (event:-prefixed, usage on message_start and message_delta). */
function anthropicTranscript(): string {
  const lines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":25,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ];
  return lines.join('\n');
}

/** Split a string into one Buffer per byte position — the every-byte partition. */
function everyByteSplits(text: string): Buffer[] {
  return Array.from(Buffer.from(text, 'utf8'), (byte) => Buffer.from([byte]));
}

function splitEvery(bytes: Buffer[], width: number): Buffer[][] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    chunks.push(Buffer.concat(bytes.slice(i, i + width)));
  }
  return [chunks];
}

function feedChunks(
  chunks: Buffer[],
  consumer?: EventConsumer,
): {
  result: StreamingResult;
  events: Array<{ event?: string; data: string }>;
} {
  const events: Array<{ event?: string; data: string }> = [];
  const parser = createEventStreamParser(
    consumer ??
      ((event): void => {
        events.push(event);
      }),
  );
  for (const chunk of chunks) {
    parser.feed(chunk);
  }
  return { result: parser.flush(), events };
}

describe('event-stream-parser — OpenAI chat/completions style', () => {
  it('extracts real model and usage-chunk tokens, never unknown/0', () => {
    const { result } = feedChunks([Buffer.from(openAiTranscript(), 'utf8')]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(7);
    expect(result.eventCount).toBe(6); // 4 delta chunks + usage chunk + [DONE]
  });

  it('usage wins over the chars/4 delta estimate', () => {
    // "Hello world" = 11 chars -> ceil(11/4) = 3 if the estimate won;
    // the terminal usage chunk carries completion_tokens 7.
    const { result } = feedChunks([Buffer.from(openAiTranscript(), 'utf8')]);
    expect(result.outputTokens).toBe(7);
    expect(result.outputTokens).not.toBe(3);
  });

  it('is provider-shaped, not toy JSON', () => {
    const text = openAiTranscript();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"usage"');
    expect(text).toContain('"delta":{"content"');
    expect(text).toContain('[DONE]');
  });
});

describe('event-stream-parser — Anthropic Messages style', () => {
  it('extracts model from message_start and tokens from usage events', () => {
    const { result, events } = feedChunks([
      Buffer.from(anthropicTranscript(), 'utf8'),
    ]);
    expect(result.model).toBe('claude-3-5-sonnet-20241022');
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(9);
    expect(result.eventCount).toBe(6);
    expect(events[0]?.event).toBe('message_start');
    expect(events[1]?.event).toBe('content_block_start');
  });

  it('does not count bare event: prefixes or blank lines as events', () => {
    const { result } = feedChunks([Buffer.from(anthropicTranscript(), 'utf8')]);
    // 6 data-bearing events despite 7 event: prefixes and many blank lines.
    expect(result.eventCount).toBe(6);
  });

  it('never falls back to unknown/0 when the transcript carries them', () => {
    const { result } = feedChunks([Buffer.from(anthropicTranscript(), 'utf8')]);
    expect(result.model).not.toBe('unknown');
    expect(result.outputTokens).not.toBe(0);
    expect(result.inputTokens).not.toBe(0);
  });
});

describe('event-stream-parser — cross-chunk integrity', () => {
  it('produces identical results when split at every byte boundary', () => {
    for (const transcript of [openAiTranscript(), anthropicTranscript()]) {
      const unsplit = feedChunks([Buffer.from(transcript, 'utf8')]).result;
      const byByte = feedChunks(everyByteSplits(transcript)).result;
      expect(byByte).toEqual(unsplit);
    }
  });

  it('is partition-invariant across a sweep of split widths', () => {
    const transcript = openAiTranscript();
    const bytes = everyByteSplits(transcript);
    const unsplit = feedChunks([Buffer.from(transcript, 'utf8')]).result;
    for (const width of [1, 2, 3, 5, 7, 11, 16, 32, 64, 127]) {
      const [chunks] = splitEvery(bytes, width);
      expect(feedChunks(chunks).result).toEqual(unsplit);
    }
  });

  it('does not corrupt a multi-byte character split across two chunks', () => {
    // One SSE event whose delta content is four CJK chars (3 bytes each).
    const body =
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"\u4e16\u754c\u60a8\u597d"},"finish_reason":null}]}\n';
    const full = body + '\n';
    const unsplit = feedChunks([Buffer.from(full, 'utf8')]).result;
    // Split the UTF-8 bytes of the four CJK chars in the MIDDLE of the
    // third character: byte offsets 0-2 char1, 3-5 char2, 6-8 char3, 9-11
    // char4. Splitting after byte 7 lands inside char3's 3-byte sequence.
    const buf = Buffer.from(full, 'utf8');
    const contentStart = buf.indexOf(Buffer.from('"content":"', 'utf8')) + 11;
    const splitAt = contentStart + 7; // mid third char
    const chunkA = buf.subarray(0, splitAt);
    const chunkB = buf.subarray(splitAt);
    const split = feedChunks([Buffer.from(chunkA), Buffer.from(chunkB)]).result;
    expect(split).toEqual(unsplit);
    // No replacement character corruption: the estimate must equal the
    // unsplit estimate (4 CJK chars * 3 bytes but 4 chars -> ceil(4/4)=1).
    expect(split.outputTokens).toBe(1);
    expect(split.model).toBe('gpt-4o-mini');
  });

  it('handles CRLF line endings', () => {
    const text = openAiTranscript().replace(/\n/g, '\r\n');
    const { result } = feedChunks([Buffer.from(text, 'utf8')]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.outputTokens).toBe(7);
    expect(result.eventCount).toBe(6);
  });
});

describe('event-stream-parser — bounded, non-accumulating capture', () => {
  it('never grows carry state with stream length (large multi-chunk stream)', () => {
    const events: Array<{ event?: string; data: string }> = [];
    const parser = createEventStreamParser((event): void => {
      events.push(event);
    });
    // 500 events, fed one tiny chunk at a time.
    const eventJson =
      '{"id":"chatcmpl-x","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"abc"},"finish_reason":null}]}';
    const singleEvent = `data: ${eventJson}\n\n`;
    const chunkBytes = Buffer.from(singleEvent, 'utf8');
    // Feed 20 bytes at a time regardless of how many events pass through.
    let totalFeeds = 0;
    for (let i = 0; i < 500; i += 1) {
      const body = Buffer.from(singleEvent, 'utf8');
      for (let off = 0; off < body.length; off += 20) {
        parser.feed(body.subarray(off, Math.min(off + 20, body.length)));
        totalFeeds += 1;
      }
    }
    const state = parser.state();
    // The tail may hold at most one partial line; dataLines holds at most
    // one partial event's lines. Bounded regardless of 500 events fed.
    expect(state.tail.length).toBeLessThanOrEqual(chunkBytes.length);
    expect(state.dataLines.length).toBeLessThanOrEqual(1);
    expect(totalFeeds).toBeGreaterThan(1000);
    const result = parser.flush();
    expect(result.eventCount).toBe(500);
    expect(events.length).toBe(500);
  });

  it('exposes no accumulating body field in the carry', () => {
    const parser = createEventStreamParser();
    for (let i = 0; i < 100; i += 1) {
      parser.feed(
        Buffer.from(
          `data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"x"}}]}\n\n`,
          'utf8',
        ),
      );
    }
    const state = parser.state() as unknown as Record<string, unknown>;
    const keys = Object.keys(state);
    // No raw-chunk list, no concatenated body string, no per-event JSON retention.
    expect(keys).not.toContain('chunks');
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('events');
    expect(keys).toContain('tail');
    expect(keys).toContain('dataLines');
    expect(state.tail).toBeInstanceOf(Buffer);
    expect((state.tail as Buffer).length).toBe(0);
  });
});

describe('event-stream-parser — purity and no-throw contract', () => {
  it('is pure: same chunk sequence fed twice returns deep-equal results', () => {
    const transcript = Buffer.from(openAiTranscript(), 'utf8');
    const a = feedChunks([transcript]).result;
    const b = feedChunks([Buffer.from(transcript)]).result;
    expect(b).toEqual(a);
  });

  it('never mutates the input transcript buffer', () => {
    const transcript = Buffer.from(openAiTranscript(), 'utf8');
    const original = Buffer.from(transcript);
    feedChunks([transcript]);
    expect(transcript.equals(original)).toBe(true);
  });

  it('falls back to unknown/0 on garbage bytes without throwing', () => {
    const { result } = feedChunks([
      Buffer.from('garbage \xff\xfe not sse', 'utf8'),
    ]);
    expect(result.model).toBe('unknown');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('falls back on truncated mid-event JSON without throwing or hanging', () => {
    const truncated = Buffer.from(
      'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"unterminated"}\n\n',
      'utf8',
    );
    const { result } = feedChunks([truncated]);
    expect(result.model).toBe('unknown');
    expect(result.outputTokens).toBe(0);
  });

  it('returns defaults for zero data: lines', () => {
    const { result } = feedChunks([Buffer.from('event: ping\n\n', 'utf8')]);
    expect(result.model).toBe('unknown');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.eventCount).toBe(0);
  });

  it('does not leak running counters across calls', () => {
    const parser = createEventStreamParser();
    parser.feed(
      Buffer.from(
        'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hello"}}]}\n\n',
        'utf8',
      ),
    );
    const first = parser.result();
    // A second parser instance fed the same input returns identical numbers.
    const again = feedChunks([
      Buffer.from(
        'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"hello"}}]}\n\n',
        'utf8',
      ),
    ]).result;
    expect(again).toEqual(first);
  });
});

describe('event-stream-parser — extraction estimate rules', () => {
  it('falls back to incremental ceil(chars/4) estimate when no usage event lands', () => {
    const transcript = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hello world"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { result } = feedChunks([Buffer.from(transcript, 'utf8')]);
    expect(result.model).toBe('gpt-4o-mini');
    // "Hello world" = 11 chars -> ceil(11/4) = 3; not 0, not 'unknown'.
    expect(result.outputTokens).toBe(3);
  });

  it('resets the estimate when a usage event lands mid-stream', () => {
    const transcript = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"aaaa"},"finish_reason":null}]}',
      '',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":99,"total_tokens":109}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const { result } = feedChunks([Buffer.from(transcript, 'utf8')]);
    expect(result.outputTokens).toBe(99); // usage wins; estimate (1) discarded
  });
});
