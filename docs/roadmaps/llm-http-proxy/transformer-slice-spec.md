# Transformer pipeline — first-slice slice spec (ADR)

Status: **binding** — `decisions.md` records the promotion on 2026-08-28 (horizon 3).
This document pins the contract for the request strand landed in horizon 3; the
response strand is out of scope and deferred to horizon 4 under the same option
names below.

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
   * NOT implemented in horizon 3 — reserved by this ADR for horizon 4.
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
 *   scope for the first slice (see section 6).
 * - Returning `undefined` (or the input unchanged) means passthrough: the
 *   original body is kept, and Content-Length is NOT rewritten.
 * - MUST NOT throw for a well-formed string input; if it does throw, the
 *   request is forwarded unchanged (passthrough) — never aborted, never sent
 *   partially transformed.
 */
type RequestTransformer = (requestBody: string) => string | undefined;

/**
 * Reserved for horizon 4. Buffered, captured, non-streaming responses only.
 * Same sync + undefined-passthrough rules; see section 6 for the boundary.
 */
type ResponseTransformer = (responseBody: string) => string | undefined;
```

The output type is what `Buffer.byteLength(..., 'utf8')` is computed over: the
replacement is encoded as UTF-8 bytes when it hits the wire and when the
`.length` for Content-Length is computed.

## 3. Enforced ordering (concrete seams)

- **Request strand:** the transform runs BETWEEN chunk capture and forwarding
  to the pristine original write/end — i.e. in `writeWrapper`/`endWrapper`,
  after the request body chunks have been accumulated and BEFORE
  `reflectCall` forwards `args` to the original. `writeWrapper` and
  `endWrapper` share this seam, so a request body sent via `write()` +
  `end(chunk)` is transformed exactly once over the concatenation, never per
  chunk.
- **Response strand (horizon 4):** the transform runs BEFORE the body reaches
  the caller. Relationship to the emission path is pinned: `emitLogEntry`'s
  `JSON.parse` sees the POST-transform body (the log entry reflects what the
  caller actually received), and redaction runs after the transform.
- **Transform-throws:** request strand — catch, forward original unchanged,
  do not rewrite Content-Length (passthrough). Response strand — same rule.
  A throwing transform must never crash the process and never abort the
  request.

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

## 5. Response buffering boundary (explicit)

Only captured, non-streaming responses qualify for buffering + transformation.
"Non-streaming" is defined concretely by the existing capture machinery: the
response body is fully buffered by `attachCapture`'s `data`/`end` handlers —
there is no SSE/streaming/chunked-response special handling in the slice.
Responses the interceptor does not already fully buffer are not transformed.
This boundary is NOT extended by this ADR.

## 6. Out of scope (named, so the next horizon cannot silently extend)

- Async (Promise-returning) transformers
- Streaming / chunk-level (per-chunk) transformation
- gzip / content-encoding-aware transformation (decoding + re-encoding)
- The response strand (`responseTransform` implementation) — horizon 4

## 7. Compensation (horizon-3 request strand)

The request strand is additive and self-contained: removing
`requestTransform` from `InterceptorOptions` and deleting the
`writeWrapper`/`endWrapper` hook restores today's passthrough behavior
exactly. No migration or rollback beyond that diff is required.