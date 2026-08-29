# Transformer pipeline — first-slice slice spec (ADR)

Status: **binding** — `decisions.md` records the promotion on 2026-08-28 (horizon 3)
and the streaming-boundary re-pin on 2026-08-28 (horizon 4).
This document pins the contract for the request strand landed in horizon 3 and
the response strand landed in horizon 4 (SSE per-event `responseTransform`).

## 1. Option names (pinned)

`InterceptorOptions` gains exactly two additive, optional fields — no
alternatives, no "decided equivalents", no TBD:

```ts
export interface InterceptorOptions {
  // ... existing fields ...
  /**
   * Transform the captured request body before it is forwarded to the wire.
   * Absent option = synchronous passthrough (today's behavior, unchanged).
   * Runs exactly once per request body, over the full concatenated capture,
   * at the terminal write/end.
   */
  requestTransform?: RequestTransformer;
  /**
   * Transform the captured response body before it reaches the caller.
   * Buffered (non-streaming) responses: runs exactly once over the full
   * concatenated response body, at the terminal 'end'.
   * SSE event-stream responses: runs once per SSE event, over that single
   * event's data payload, as each event is parsed (see sections 2 and 3).
   * Absent option = passthrough. Implemented in horizon 4.
   */
  responseTransform?: ResponseTransformer;
}
```

The field names are final: `requestTransform` and `responseTransform`. Any code
in this horizon or the next MUST use exactly these names.

## 2. Transformer signatures (callable, sync-only)

```ts
/**
 * Receive the fully concatenated request body as a UTF-8 string, return the
 * (possibly different) body to send on the wire.
 *
 * - MUST be synchronous. Async/streaming/chunk-level transformers are out of
 *   scope (see section 6).
 * - Returning `undefined` (or the input unchanged) means passthrough: the
 *   original body is kept, and Content-Length is NOT rewritten.
 * - MUST NOT throw for a well-formed string input; if it does throw, the
 *   request is forwarded unchanged (passthrough) — never aborted, never sent
 *   partially transformed.
 */
type RequestTransformer = (requestBody: string) => string | undefined;

/**
 * Transform a captured response body before it reaches the caller. The
 * argument is a UTF-8 string and the return is the (possibly different)
 * string (or undefined = passthrough). Sync-only, never throws on
 * well-formed input (a throw is caught and treated as passthrough).
 *
 * Invocation semantics depend on the response path:
 * - Buffered (non-streaming) responses: invoked exactly once over the full
 *   concatenated capture, at the terminal 'end' — the horizon-3 contract.
 * - SSE event-stream responses: invoked once PER SSE event, over that single
 *   event's data payload (the parsed `data:` line), as the event is parsed.
 *   The event's JSON document is what the transformer receives; its output is
 *   what the per-event JSON.parse / redaction sees. Memory stays bounded:
 *   the transform never sees (and is never asked to produce) a concatenated
 *   stream body.
 */
type ResponseTransformer = (responseBody: string) => string | undefined;
```

The output type is what `Buffer.byteLength(..., 'utf8')` is computed over for
Content-Length on the request strand: the replacement is encoded as UTF-8 bytes
when it hits the wire. On the response strand no Content-Length is maintained;
the transform output feeds the entry's emission path.

## 3. Enforced ordering (concrete seams)

- **Request strand:** the transform runs BETWEEN chunk capture and forwarding
  to the pristine original write/end — i.e. in `writeWrapper`/`endWrapper`,
  after the request body chunks have been accumulated and BEFORE
  `reflectCall` forwards `args` to the original. `writeWrapper` and
  `endWrapper` share this seam, so a request body sent via `write()` +
  `end(chunk)` is transformed exactly once over the concatenation, never per
  chunk.
- **Response strand — buffered path (binding, kept verbatim from horizon 3):**
  the transform runs BEFORE the body reaches the caller. Relationship to the
  emission path is pinned: `emitLogEntry`'s `JSON.parse` sees the POST-transform
  body (the log entry reflects what the caller actually received), and
  redaction runs after the transform. (This sentence is the horizon-3 contract
  word-for-word; it remains binding for the buffered response path.)
- **Response strand — SSE per-event path (parallel clause, horizon 4):** the
  transform runs per SSE event BEFORE the event's data reaches the caller.
  `emitLogEntry`'s `JSON.parse`/extraction sees the POST-transform per-event
  body (each event's data is what the caller received for that event), and
  redaction runs after the transform, per event. Memory is bounded-capture:
  events are transformed individually and never accumulated into a full body
  before transformation.
  **Named residual (binding, per-event redaction):** a sensitive field value
  whose bytes span two SSE events is not recognized by per-event redaction
  (each event is walked independently); this is accepted as a decided
  limitation of the per-event path, not a silent gap — see section 6.
- **Transform-throws:** request strand — catch, forward original unchanged,
  do not rewrite Content-Length (passthrough). Response strand — same rule:
  a throwing transform during buffered or per-event processing is caught and
  treated as passthrough for that body/event. A throwing transform must never
  crash the process and never abort the request or skip event streaming.

## 4. Content-Length policy (exhaustive decision table)

`Content-Length` is rewritten ONLY when a captured request body was actually
replaced by the transform. Every header state has a verdict:

| State | Verdict |
|---|---|
| No `requestTransform` option configured | passthrough — header untouched |
| Header absent | passthrough — no `Content-Length` is written |
| `transfer-encoding: chunked` present | passthrough — no `Content-Length` written or rewritten, chunked framing intact |
| `content-encoding: gzip` present | passthrough — the interceptor does not decode or re-encode; header untouched |
| Header present + captured body actually replaced | `Content-Length = Buffer.byteLength(transformedBody, 'utf8')`, set via `setHeader` before the original write/end forwards |
| Header present + transform returned `undefined` or byte-identical body | passthrough — keep the caller's original header value |

Byte length, never `.length` (character count), for multi-byte UTF-8 payloads.

## 5. Response strand boundary (re-pinned, horizon 4)

Two response shapes qualify for transformation:

- **Buffered (non-streaming) responses** — the response body is fully buffered
  by `attachCapture`'s `data`/`end` handlers, then transformed exactly once
  over the concatenation, per section 3.
- **SSE event-stream responses** — detected by content-type
  `text/event-stream` plus the `data:`/`event:` line shape; each event is
  parsed incrementally, transformed once per event, and redacted per event.

Bounded-capture semantics bind both shapes: when `capturePayloads = false`,
the stream is never accumulated — `responseBodyChunks` is never appended on
the SSE path, and only the incremental per-event parse and running counters
hold state. When `capturePayloads = true`, the retained
`maskedResponseBody` is the per-event redacted JSON of the transformed
events, held in a bounded accumulator — never the raw concatenated stream.
SSE-detection misroutes (a non-SSE chunked body containing `data:` text)
fall back to the buffered behavior below.

Responses the interceptor does not already fully buffer, and no other
streaming format (NDJSON-without-event-framing, WebSocket, raw byte-streams),
are not transformed. This boundary IS extended by this ADR to bounded SSE
event-streams; it is NOT extended to unbounded accumulation of any kind.

## 6. Out of scope (named, so the next horizon cannot silently extend)

- Async (Promise-returning) transformers
- gzip / content-encoding-aware transformation (decoding + re-encoding)
- Non-SSE streaming formats (NDJSON without event framing, WebSocket, raw
  byte-streams)
- Request-strand streaming / chunk-level request transformation — the request
  strand keeps the fully-buffered synchronization boundary of section 3
- Cross-event redaction continuity — a sensitive field value whose bytes span
  two SSE events is not recognized by per-event redaction; this is a named
  residual of the per-event path in section 3, accepted as binding, not a
  silent gap
- Rewriting the caller-visible stream to replay transformed bytes — response
  delivery stays listener-only; "before the body reaches the caller" is
  grounded against the buffered/per-event copy used for emission

## 7. Compensation

- **Request strand (horizon 3):** additive and self-contained — removing
  `requestTransform` from `InterceptorOptions` and deleting the
  `writeWrapper`/`endWrapper` hook restores today's passthrough behavior
  exactly.
- **Response strand (horizon 4):** flipping SSE detection off (the
  content-type check never matches) returns the response path exactly to the
  pre-horizon buffered behavior; the additive parser/option imports become
  dead-but-harmless code. No migration beyond that flip is required.