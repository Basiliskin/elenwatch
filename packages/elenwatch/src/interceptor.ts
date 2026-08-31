/**
 * elenwatch interceptor core.
 *
 * Captures in-process LLM provider HTTP/HTTPS traffic by patching TWO
 * surfaces once process-wide (singleton guarded):
 *
 *   1. `http.ClientRequest.prototype.write/end` — covers `http.request`
 *      and `https.request`. Patching the prototype — rather than the
 *      `http.request` / `https.request` exports — is the only interception
 *      point that works in both real Node (where those exports are
 *      writable data properties) and under a frozen module registry like
 *      Jest's (where they are non-writable accessors); Node's own
 *      `request` constructs a `ClientRequest` and every write/end flows
 *      through the prototype.
 *
 *   2. undici's global dispatcher via `setGlobalDispatcher` — covers
 *      `globalThis.fetch` (Node 18+ fetch is undici-backed). The wrapping
 *      dispatcher builds a synthetic `ClientRequest`-shaped view from
 *      `DispatchOptions` and routes every request through the same
 *      `emitLogEntry` builder used by the http-patch path. The `undici`
 *      package is an optional peer dep; when absent, install() silently
 *      skips this surface.
 *
 * Latency discipline: the original write/end forward through synchronously
 * first; payload capture and emission are deferred to response listeners /
 * a setImmediate callback, never on the synchronous request path. The
 * undici wrapping dispatcher's handler does the same — synthetic events
 * are emitted into the captured listener graph and `emitLogEntry` runs
 * inside a setImmediate.
 *
 * Exception — buffer-and-hold: when a `requestTransform` is configured,
 * captured requests withhold their body chunks from the socket until
 * end(), so the transform can run once over the full body and be written
 * in a single terminal call (see holdWrite/holdEnd). Streamed fetch()
 * bodies are never buffered: observeRequestBody is a pull-through
 * generator with exact backpressure.
 */

import { EventEmitter } from 'node:events';
import { ClientRequest, IncomingMessage } from 'node:http';
import * as http from 'node:http';
import type { Dispatcher } from 'undici-types';

type UndiciDispatchOptions = Dispatcher.DispatchOptions;
type UndiciDispatchHandlers = Dispatcher.DispatchHandlers;
import {
  createEventStreamParser,
  type StreamingResult,
} from './event-stream-parser';
import {
  ParseResult,
  ProviderParser,
  defaultParser,
  parseCall,
} from './provider-parser';
import { Logger, consoleLogger } from './logger';
import { peerRequire } from './peer-require';
import { RedactionConfig, redact } from './redaction';
import {
  BodyDroppedInfo,
  InterceptorOptions,
  LlmLogEntry,
  RequestTransformer,
  ResponseTransformer,
  TokenCounter,
} from './options';

const DEFAULT_PROVIDERS: string[] = [
  'api.openai.com',
  'api.anthropic.com',
  'api.cohere.ai',
  'api.mistral.ai',
];

/**
 * Default cap on buffered request and response bodies. ~10 MiB: high
 * enough not to clip realistic LLM payloads (a 32k-token context can run
 * several MB through a chat-completions response), low enough to bound
 * the memory exposure a malicious or runaway provider can pin via the
 * capture-side buffer. Defense-in-depth on top of the providers filter;
 * NOT the primary privacy boundary.
 */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

// Optional peer dep: undici (^6.0.0 || ^7.0.0). When the peer is installed
// (npm install undici), this resolves to a module exposing
// setGlobalDispatcher / getGlobalDispatcher / Dispatcher — the surface the
// dual-patch in install()/restore() uses to capture global fetch traffic.
// When the peer is absent, this stays undefined and install() silently
// skips the undici side (preserving zero-hard-deps public surface).
// Same lazy-require pattern as src/otel.ts. Loaded through `peerRequire` so
// resolution works in both the CJS and the ESM build; a bare `require` here
// throws `require is not defined` under ESM and is misread as "peer absent".
// The undici-types module shim at src/types-undici.d.ts makes
// `typeof import('undici')` resolve to undici-types' shape at type-check
// time even when the undici package is not installed.
type UndiciApi = typeof import('undici');

let undici: UndiciApi | undefined;
try {
  undici = peerRequire('undici') as UndiciApi;
} catch {
  // Peers not installed — leave `undici` undefined so install()/restore()
  // silently skip the undici side.

  undici = undefined;
}

export {
  defaultEstimateInputTokens,
  defaultExtractOutputTokens,
} from './provider-parser';

/** Payload bookkeeping attached to a ClientRequest whose url is captured. */
interface CaptureState {
  requestBodyChunks: Buffer[];
  responseBodyChunks: Buffer[];
  capturedEnd: boolean;
  finished: boolean;
  /** True once completeCapture has started the (single) deferred emission. */
  emitted: boolean;
  /** Caller trace captured SYNCHRONOUSLY at write/end time (the async
   *  emission path loses the caller stack). */
  callerTrace: string;
  /** Set when the request transform replaced the captured body; the wire
   *  gets the transformed bytes AND the log entry reflects them (ADR §3). */
  transformedBody?: string;
  /** True once this response was detected as an SSE event-stream. */
  isSse?: boolean;
  /** Streaming parser state; present only on the SSE path. */
  streamParser?: ReturnType<typeof createEventStreamParser>;
  /** Bounded accumulator of per-event redacted JSON when capturePayloads=true. */
  redactedEvents?: unknown[];
  /** The streaming parse result as of the last fed chunk (never the body). */
  streamResult?: StreamingResult;
  /** SSE line-shape probe carry (bounded, 2-leading-lines). */
  probe?: { buffer: Buffer; probed: boolean };
  /** Destination host for this request, captured at attachCapture time.
   *  Read by appendChunk's cap-trip path to populate the onBodyDropped
   *  info payload — kept on the state so the byte-cap enforcement code
   *  path does not need to reach back to the (possibly released) req. */
  host: string;
  /** Running byte total per direction, accounting the actual byte length
   *  of every chunk buffered so far (not chunk count). Compared against
   *  the configured maxBodyBytes inside appendChunk to short-circuit
   *  further capture for a direction once the cap is tripped. */
  bytesCaptured: { request: number; response: number };
  /** Per-direction trip latch — once true for a direction, appendChunk
   *  early-returns for that direction so the trip fires exactly once
   *  per (host, direction). Kept separate for request and response so a
   *  request trip does not silence the response path and vice versa. */
  bodyDropped: { request: boolean; response: boolean };
  /** Buffer-and-hold mode (http/https path with a requestTransform
   *  configured): every write is withheld from the wire and its bytes
   *  collected here, UNCAPPED (wire fidelity — maxBodyBytes only ever
   *  truncates the capture copy). At end() the full body is transformed
   *  once and written in a single terminal call, so headers flush only
   *  after Content-Length is final. `undefined` means hold mode never
   *  started for this request (no transform, or headers were already
   *  flushed at the first body byte — the degraded passthrough path). */
  heldWireChunks?: Buffer[];
  /** Fetch-path passthrough body observer: true from dispatch until the
   *  wrapping async generator's finally has run (normal completion,
   *  upstream throw, and undici cancellation all clear it). While true,
   *  a SUCCESS terminal in completeCapture is deferred so the log entry
   *  can never carry a partially-captured request body. */
  requestStreamPending?: boolean;
  /** Set when a success terminal arrived while requestStreamPending —
   *  the generator's finally re-enters completeCapture. */
  deferredTerminal?: boolean;
}

const kCapture = Symbol('elenwatch.capture');
// Negative capture-decision cache: once shouldCapture says false for a
// request, the tag is set and every wrapper short-circuits without re-
// running the decision. Scoped to the request instance, so it cannot go
// stale (hostname is fixed after construction) and restore() needs no
// cleanup.
const kNoCapture = Symbol('elenwatch.noCapture');

// Install guard stored on the prototype itself: a second Interceptor (or a
// second install()) can never stack a second write/end wrapper.
const kWriteWrapper = Symbol('elenwatch.writeWrapper');
const kEndWrapper = Symbol('elenwatch.endWrapper');
const kOnWrapper = Symbol('elenwatch.onWrapper');
// Install guard tagged on the WrappingDispatcher instance itself: lets
// install() detect that the global dispatcher is already our wrapper and
// skip re-wrapping, and lets restore() assert reference identity before
// reinstating the captured original.
const kDispatcherWrapper = Symbol('elenwatch.dispatcherWrapper');

/** Shape returned by `undici.getGlobalDispatcher()`. Same class hierarchy
 *  that `typeof import('undici').Dispatcher` resolves to through the
 *  `src/types-undici.d.ts` shim when the `undici` peer is installed. */
type UndiciDispatcher = Dispatcher;

/** Normalize undici DispatchOptions.headers (string | string[] | Iterable
 *  tuples | IncomingHttpHeaders) to a flat lowercase-keyed map so the
 *  synthetic ClientRequest's getHeader() can answer `host` and friends. */
function normaliseUndiciHeaders(
  raw: UndiciDispatchOptions['headers'],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) {
    return out;
  }
  if (
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    !(Symbol.iterator in raw)
  ) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        out[k.toLowerCase()] = v;
      } else if (Array.isArray(v) && typeof v[0] === 'string') {
        out[k.toLowerCase()] = v[0];
      }
    }
    return out;
  }
  const iterable = raw as Iterable<[string, string | string[]]>;
  for (const pair of iterable) {
    const name = String(pair[0]).toLowerCase();
    const value = pair[1];
    if (typeof value === 'string') {
      out[name] = value;
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      out[name] = value[0];
    }
  }
  return out;
}

/** Normalize the raw headers Buffer[] that undici hands to onHeaders()
 *  (one Buffer per header line, `name: value` form) into a lowercase-keyed
 *  string map. */
function normaliseRawHeaderBuffers(
  raw: ReadonlyArray<Buffer> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null) {
    return out;
  }
  for (const buf of raw) {
    const line = buf.toString('utf8');
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    out[name] = value;
  }
  return out;
}

/**
 * Wrapping undici Dispatcher that re-routes every dispatched request
 * through the existing `emitLogEntry` builder by constructing a synthetic
 * `http.ClientRequest`-shaped view from the plain `DispatchOptions` object.
 *
 * The synthetic view satisfies every field the existing code reads from a
 * real `ClientRequest` (hostname, port, path, protocol, getHeader) via the
 * duck-typed `as unknown as` view-cast discipline already used elsewhere in
 * this file. All real I/O stays on `original.dispatch()` — this wrapper
 * only observes.
 *
 * Latency discipline (same as the http-patch path): the wrapped handler
 * defers `emitLogEntry` to a `setImmediate`, never on the synchronous
 * dispatch path. The handler invokes the wrapped handler's callbacks
 * first, then routes data/end/error events into the synthetic request's
 * listener graph that `attachCapture` already installed.
 */
class WrappingDispatcher extends EventEmitter {
  readonly [kDispatcherWrapper] = true;

  constructor(
    private readonly original: UndiciDispatcher,
    private readonly interceptor: Interceptor,
  ) {
    super();
  }

  dispatch(
    options: UndiciDispatchOptions,
    handler: UndiciDispatchHandlers,
  ): boolean {
    // The synthetic ClientRequest-shaped view. The fields below are the
    // exact subset read by emitLogEntry / deriveUrl / resolveScheme /
    // reqHostname (all view-cast into http.ClientRequest via Tagged).
    const originStr =
      options.origin instanceof URL
        ? options.origin.toString()
        : (options.origin ?? 'http://localhost');
    const originUrl = new URL(originStr);
    const headerMap = normaliseUndiciHeaders(options.headers);
    const hostHeader = headerMap.host ?? originUrl.host;
    const headersLower = new Map<string, string>(Object.entries(headerMap));
    const syntheticReq = new EventEmitter();
    Object.assign(syntheticReq, {
      hostname: originUrl.hostname,
      port:
        originUrl.port !== ''
          ? Number(originUrl.port)
          : originUrl.protocol === 'https:'
            ? 443
            : 80,
      path: options.path || '/',
      protocol: originUrl.protocol,
      method: options.method,
      getHeader(name: string): string | undefined {
        return syntheticGetHeader(name, headersLower, hostHeader);
      },
    });

    // Honour the user-supplied `providers` filter the same way the
    // http/https patch path does — without this guard, every global
    // fetch() would attach a capture listener and pin a per-request
    // body buffer even for non-provider hosts. Short-circuit to the
    // original dispatcher BEFORE any capture-state allocation when
    // shouldCapture says no; the negative half of the bug is the
    // memory-pin on responseBodyChunks, not just the log spam.
    const shouldAttach = shouldCapture(
      syntheticReq as unknown as ClientRequest,
      this.interceptor.providers,
    );
    if (!shouldAttach) {
      return this.original.dispatch(options, handler);
    }

    // Capture bookkeeping. attachCapture installs req.on('response', ...)
    // and req.on('error', ...) listeners — both route through synthetic
    // events fired by the wrapped handler below.
    const callerTrace = captureCallerTrace();
    this.interceptor.attachCapture(
      syntheticReq as unknown as ClientRequest,
      callerTrace,
    );

    // Capture the request body. undici hands plain string / Buffer /
    // Uint8Array bodies through verbatim, and wraps any other fetch body
    // shape (string, BufferSource, FormData, ReadableStream) in an
    // AsyncIterable. The string and Buffer/Uint8Array paths capture
    // synchronously before dispatch() returns. The AsyncIterable path
    // wraps the caller's stream in a passthrough async generator
    // (observeRequestBody): undici pulls the generator, the generator
    // pulls upstream — exact backpressure, no full-body buffering, no
    // dispatch deferral — while copying each chunk into the capped
    // capture buffer as a side effect. The wire always gets the
    // caller's bytes untouched.
    let syntheticRes: EventEmitter | undefined;
    const wrappedHandler: UndiciDispatchHandlers = {
      onConnect: (abort) => {
        handler.onConnect?.(abort);
      },
      onError: (err) => {
        handler.onError?.(err);
        syntheticReq.emit('error', err);
      },
      onUpgrade: (statusCode, headers, socket) => {
        handler.onUpgrade?.(statusCode, headers, socket);
      },
      onResponseStarted: () => {
        handler.onResponseStarted?.();
      },
      onHeaders: (statusCode, headers, resume, statusText) => {
        const resHeaders = normaliseRawHeaderBuffers(headers);
        syntheticRes = new EventEmitter();
        Object.assign(syntheticRes, {
          statusCode,
          statusMessage: statusText,
          headers: resHeaders,
          aborted: false,
          complete: false,
        });
        // attachCapture listens for 'response' and installs data/end/error/
        // aborted/close listeners on the IncomingMessage-shaped object.
        syntheticReq.emit('response', syntheticRes);
        return (
          handler.onHeaders?.(statusCode, headers, resume, statusText) ?? true
        );
      },
      onData: (chunk) => {
        syntheticRes?.emit('data', chunk);
        return handler.onData?.(chunk) ?? true;
      },
      onComplete: (trailers) => {
        if (syntheticRes !== undefined) {
          syntheticRes.emit('end');
        }
        handler.onComplete?.(trailers);
      },
      onBodySent: (chunkSize, totalBytesSent) => {
        handler.onBodySent?.(chunkSize, totalBytesSent);
      },
    };
    const state = (syntheticReq as unknown as Tagged)[kCapture] as
      CaptureState | undefined;
    if (
      state !== undefined &&
      options.body !== undefined &&
      options.body !== null
    ) {
      // Single cap context shared by every body-shape branch on this
      // fetch dispatch — built from the interceptor instance fields that
      // are immutable after construction, so reusing the same object for
      // both the sync and the async branches is safe and avoids
      // per-chunk reallocation inside the drain.
      const reqCapCtx = {
        state,
        direction: 'request' as const,
        cap: this.interceptor.maxBodyBytes,
        onDropped: this.interceptor.onBodyDropped,
      };
      const body = options.body;
      if (typeof body === 'string') {
        appendChunk(state.requestBodyChunks, body, 'utf8', reqCapCtx);
        state.capturedEnd = true;
        state.finished = true;
      } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        appendChunk(state.requestBodyChunks, body, undefined, reqCapCtx);
        state.capturedEnd = true;
        state.finished = true;
      } else if (typeof body === 'object' && Symbol.asyncIterator in body) {
        // Passthrough observer. Emission ordering: requestStreamPending
        // makes completeCapture defer a SUCCESS terminal (onComplete)
        // until the generator's finally has run, so the entry can never
        // carry a partially-captured request body. An ERROR terminal
        // emits immediately — a failed request's body will never
        // complete (and on some error paths undici never starts the
        // generator at all, so waiting would defer forever); the error
        // entry is allowed to carry the partial capture.
        //
        // The flag is set eagerly (a generator body runs nothing until
        // its first pull); the generator's finally clears it on normal
        // completion, upstream throw, and undici cancellation alike.
        state.requestStreamPending = true;
        options.body = observeRequestBody(
          body as AsyncIterable<unknown>,
          state,
          reqCapCtx,
          syntheticReq as unknown as ClientRequest,
          this.interceptor,
        ) as unknown as typeof options.body;
      }
    }

    return this.original.dispatch(options, wrappedHandler);
  }

  // ---------------------------------------------------------------
  // Pass-throughs for the rest of the Dispatcher surface. global
  // fetch exercises only dispatch(); the others exist to satisfy the
  // Dispatcher interface and to forward explicit lifecycle calls.
  // ---------------------------------------------------------------

  close(): Promise<void>;
  close(callback: () => void): void;
  close(...args: unknown[]): Promise<void> | void {
    return (this.original.close as (...a: unknown[]) => Promise<void> | void)(
      ...args,
    );
  }

  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  destroy(...args: unknown[]): Promise<void> | void {
    return (this.original.destroy as (...a: unknown[]) => Promise<void> | void)(
      ...args,
    );
  }

  connect(options: Dispatcher.ConnectOptions): Promise<Dispatcher.ConnectData>;
  connect(
    options: Dispatcher.ConnectOptions,
    callback: (err: Error | null, data: Dispatcher.ConnectData) => void,
  ): void;
  connect(...args: unknown[]): Promise<Dispatcher.ConnectData> | void {
    return (
      this.original.connect as (
        ...a: unknown[]
      ) => Promise<Dispatcher.ConnectData> | void
    )(...args);
  }

  compose(
    dispatchers: Dispatcher.DispatcherComposeInterceptor[],
  ): Dispatcher.ComposedDispatcher;
  compose(
    ...dispatchers: Dispatcher.DispatcherComposeInterceptor[]
  ): Dispatcher.ComposedDispatcher;
  compose(...args: unknown[]): Dispatcher.ComposedDispatcher {
    return (
      this.original.compose as (
        ...a: unknown[]
      ) => Dispatcher.ComposedDispatcher
    )(...args);
  }

  request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData>;
  request(
    options: Dispatcher.RequestOptions,
    callback: (err: Error | null, data: Dispatcher.ResponseData) => void,
  ): void;
  request(...args: unknown[]): Promise<Dispatcher.ResponseData> | void {
    return (
      this.original.request as (
        ...a: unknown[]
      ) => Promise<Dispatcher.ResponseData> | void
    )(...args);
  }

  pipeline(
    options: Dispatcher.PipelineOptions,
    handler: Dispatcher.PipelineHandler,
  ): Dispatcher extends never ? never : ReturnType<Dispatcher['pipeline']>;
  pipeline(...args: unknown[]): unknown {
    return (this.original.pipeline as (...a: unknown[]) => unknown)(...args);
  }

  stream(
    options: Dispatcher.RequestOptions,
    factory: Dispatcher.StreamFactory,
  ): Promise<Dispatcher.StreamData>;
  stream(
    options: Dispatcher.RequestOptions,
    factory: Dispatcher.StreamFactory,
    callback: (err: Error | null, data: Dispatcher.StreamData) => void,
  ): void;
  stream(...args: unknown[]): Promise<Dispatcher.StreamData> | void {
    return (
      this.original.stream as (
        ...a: unknown[]
      ) => Promise<Dispatcher.StreamData> | void
    )(...args);
  }

  upgrade(options: Dispatcher.UpgradeOptions): Promise<Dispatcher.UpgradeData>;
  upgrade(
    options: Dispatcher.UpgradeOptions,
    callback: (err: Error | null, data: Dispatcher.UpgradeData) => void,
  ): void;
  upgrade(...args: unknown[]): Promise<Dispatcher.UpgradeData> | void {
    return (
      this.original.upgrade as (
        ...a: unknown[]
      ) => Promise<Dispatcher.UpgradeData> | void
    )(...args);
  }
}

type Tagged = Record<symbol, unknown>;

/** Treat an object as a symbol-keyed bag (symbols cannot collide). */
function tag(target: object): Tagged {
  return target as unknown as Tagged;
}

/**
 * Decode a single streamed body chunk into raw bytes, identically for the
 * size-capped capture buffer and the untruncated wire buffer. Decoding
 * per chunk (rather than per concatenated buffer) is safe here because the
 * bytes themselves are preserved — a multi-byte character split across two
 * chunks is only interpreted later, on the joined buffer.
 */
function chunkToBuffer(chunk: unknown, encoding?: string): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding as BufferEncoding);
  }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    return Buffer.from(chunk as Uint8Array);
  }
  if (typeof chunk === 'object' || typeof chunk === 'function') {
    try {
      return Buffer.from(JSON.stringify(chunk), 'utf8');
    } catch {
      return Buffer.from('<unserializable>', 'utf8');
    }
  }
  // Primitive (number | boolean | bigint | symbol): the object guard above
  // already excluded objects, so String() cannot produce the `[object
  // Object]` leak the lint rule guards against.
  return Buffer.from(String(chunk), 'utf8');
}

function appendChunk(
  chunks: Buffer[],
  chunk: unknown,
  encoding?: string,
  capCtx?: {
    state: CaptureState;
    direction: 'request' | 'response';
    cap: number;
    onDropped: ((info: BodyDroppedInfo) => void) | undefined;
  },
): void {
  if (capCtx && capCtx.state.bodyDropped[capCtx.direction]) {
    // Trip latch already set for this direction — silent early-return so
    // we don't re-fire the callback and don't waste cycles on already-
    // over-cap bytes. Runs BEFORE the chunk decoding so an over-cap
    // stream doesn't even build the Buffer.
    return;
  }
  if (chunk === null || chunk === undefined) {
    return;
  }
  const buf = chunkToBuffer(chunk, encoding);
  if (capCtx) {
    // Per-direction byte accounting. `byteLength` is the actual byte count
    // for UTF-8 strings / Buffers / Uint8Arrays — never string `.length`
    // (which would under-count multi-byte characters). The trip condition
    // is "this chunk alone would push us over" rather than "we're already
    // at the cap" so we trip on the first chunk that overflows, never on
    // an exact-fit chunk.
    const nextBytes =
      capCtx.state.bytesCaptured[capCtx.direction] + buf.byteLength;
    if (nextBytes > capCtx.cap) {
      capCtx.state.bodyDropped[capCtx.direction] = true;
      capCtx.state.bytesCaptured[capCtx.direction] = capCtx.cap;
      const info: BodyDroppedInfo = {
        host: capCtx.state.host,
        direction: capCtx.direction,
        bytes: capCtx.cap,
        cap: capCtx.cap,
      };
      // Operator-facing log line so the trip is visible without a custom
      // listener. Only emitted when no onBodyDropped callback is configured:
      // a caller who supplied the callback has taken ownership of the signal,
      // so the extra stderr write is just noise in their logs. console.error
      // not console.log — body-cap events are operations signals, not normal
      // log entries.
      if (capCtx.onDropped === undefined) {
        console.error(
          `elenwatch: dropping body for host ${info.host}, ${buf.byteLength} bytes exceeds maxBodyBytes ${info.cap} (${info.direction})`,
        );
      }
      try {
        capCtx.onDropped?.(info);
      } catch {
        // A throwing onBodyDropped must never break the intercepted call.
      }
      return;
    }
    capCtx.state.bytesCaptured[capCtx.direction] = nextBytes;
  }
  chunks.push(buf);
}

/**
 * Passthrough request-body observer for the fetch/undici path.
 *
 * Wraps the caller's AsyncIterable body in an async generator that pulls
 * upstream only when undici pulls it (exact backpressure — the request
 * streams at wire speed, never buffered whole), copies each chunk into
 * the capped capture buffer as a side effect, and yields the caller's
 * bytes to the wire untouched. This is the tee-like split done right: a
 * `ReadableStream.tee()` would let the capture branch drain the source at
 * memory speed and queue the whole body for the wire branch unboundedly;
 * a pull-through generator has exactly one consumer driving the source.
 *
 * The `finally` runs on normal completion, on an upstream throw (which
 * propagates into undici and fails the request via onError), and when
 * undici cancels the body iterable (`return()`), so the pending flag
 * cannot stay stuck once the generator has started. A deferred success
 * terminal parked by completeCapture is re-entered from here.
 */
async function* observeRequestBody(
  src: AsyncIterable<unknown>,
  state: CaptureState,
  capCtx: {
    state: CaptureState;
    direction: 'request' | 'response';
    cap: number;
    onDropped: ((info: BodyDroppedInfo) => void) | undefined;
  },
  syntheticReq: ClientRequest,
  interceptor: Interceptor,
): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of src) {
      appendChunk(state.requestBodyChunks, chunk, undefined, capCtx);
      if (chunk !== null && chunk !== undefined) {
        yield chunkToBuffer(chunk, undefined);
      }
    }
  } finally {
    state.requestStreamPending = false;
    state.capturedEnd = true;
    state.finished = true;
    if (state.deferredTerminal === true) {
      state.deferredTerminal = false;
      interceptor.completeCapture(syntheticReq, state);
    }
  }
}

/** Extract the optional encoding argument from a write/end arg list. */
function encodingArg(args: unknown[]): string | undefined {
  return typeof args[1] === 'string' ? args[1] : undefined;
}

/**
 * Buffer-and-hold, the write half. When a requestTransform is configured,
 * body chunks are withheld from the wire (collected uncapped in
 * `state.heldWireChunks`) so the transform can run once over the FULL body
 * at end() — a chunk forwarded early can never be un-sent, which is
 * exactly how the old rewrite-args-at-end approach corrupted multi-write
 * requests (earlier chunks already on the wire + the full transformed body
 * written again at end) and crashed on setHeader after headers flushed.
 *
 * Returns true when the chunk was withheld (the wrapper must NOT forward
 * to the original write, must invoke the caller's callback, and must
 * return true — headers stay unflushed, so end()-time setHeader is legal
 * by construction). Returns false for the degraded passthrough path:
 * headers were already flushed before the first body byte (an explicit
 * flushHeaders() call), where transforming could contradict a
 * Content-Length that is already on the wire — the body then passes
 * through untransformed and untouched.
 *
 * Hold mode latches per-request via the presence of `heldWireChunks`:
 * once holding, every subsequent chunk is held (a mid-request
 * flushHeaders() cannot reorder held bytes behind passed-through ones).
 */
function holdWrite(
  req: ClientRequest,
  state: CaptureState,
  args: unknown[],
): boolean {
  if (state.heldWireChunks === undefined) {
    if ((req as unknown as { headersSent?: boolean }).headersSent === true) {
      return false;
    }
    state.heldWireChunks = [];
  }
  const chunk = args[0];
  if (chunk !== null && chunk !== undefined && typeof chunk !== 'function') {
    state.heldWireChunks.push(chunkToBuffer(chunk, encodingArg(args)));
  }
  const last = args[args.length - 1];
  if (typeof last === 'function') {
    // The caller's flush callback: the bytes are safely buffered, which is
    // the strongest guarantee a userland observer can distinguish here.
    process.nextTick(last);
  }
  return true;
}

/**
 * Buffer-and-hold, the end half. Concatenates the held wire bytes (plus
 * end()'s own final chunk), runs the transform exactly once over the full
 * body, updates Content-Length from Buffer.byteLength(..., 'utf8') — only
 * when a Content-Length header is already present (chunked / absent-header
 * requests never gain one), and headers are guaranteed unflushed because
 * every write was withheld — and returns the argument list for a single
 * terminal call to the original end(). Returns undefined for the degraded
 * passthrough path (hold mode never started AND headers are already
 * flushed): the wrapper then forwards the caller's args unchanged.
 *
 * A throwing transform, or one returning undefined / the unchanged input,
 * forwards the original bytes (ADR §3).
 */
function holdEnd(
  req: ClientRequest,
  state: CaptureState,
  transform: RequestTransformer,
  args: unknown[],
): unknown[] | undefined {
  const headersSent =
    (req as unknown as { headersSent?: boolean }).headersSent === true;
  if (state.heldWireChunks === undefined && headersSent) {
    return undefined;
  }
  const held = state.heldWireChunks ?? [];
  const chunk = args[0];
  if (chunk !== null && chunk !== undefined && typeof chunk !== 'function') {
    held.push(chunkToBuffer(chunk, encodingArg(args)));
  }
  const last = args[args.length - 1];
  const cb = typeof last === 'function' ? last : undefined;
  let out = Buffer.concat(held);
  if (!headersSent && out.length > 0) {
    const original = out.toString('utf8');
    let replaced: string | undefined;
    try {
      replaced = transform(original);
    } catch {
      replaced = undefined;
    }
    if (replaced !== undefined && replaced !== original) {
      state.transformedBody = replaced;
      out = Buffer.from(replaced, 'utf8');
      const getHeader = (
        req as unknown as { getHeader?: (n: string) => unknown }
      ).getHeader;
      const existing =
        typeof getHeader === 'function'
          ? getHeader.call(req, 'content-length')
          : undefined;
      if (existing !== undefined) {
        (
          req as unknown as {
            setHeader?: (n: string, v: string | number) => void;
          }
        ).setHeader?.call(req, 'content-length', out.byteLength);
      }
    }
  }
  if (out.length > 0) {
    return cb !== undefined ? [out, cb] : [out];
  }
  return cb !== undefined ? [cb] : [];
}

/**
 * The Nest-free, singleton-safe payload-capturing interceptor.
 *
 * ```
 * const interceptor = new Interceptor(options);
 * interceptor.install();   // patch http.ClientRequest.prototype AND undici global dispatcher (no-op if already installed)
 * // ... app runs ...
 * interceptor.restore();   // reinstate originals by reference identity (idempotent)
 * ```
 */
export class Interceptor {
  /** Providers the interceptor should capture traffic for. Public/read-
   *  only so the wrapping undici dispatcher class can run the same
   *  shouldCapture precheck the http/https patch path runs on the
   *  prototype-replaced write/end methods. Mutating the array is a
   *  no-op (the install-time copy below freezes the set) — re-create
   *  the interceptor to change providers. */
  public readonly providers: readonly (string | RegExp)[];
  private readonly capturePayloads: boolean;
  private readonly logger: Logger;
  private readonly tokenCounter: TokenCounter;
  private readonly providerParser: ProviderParser | undefined;
  private readonly redaction: RedactionConfig | undefined;
  private readonly requestTransform: RequestTransformer | undefined;
  private readonly responseTransform: ResponseTransformer | undefined;
  /** Byte cap on buffered request and response bodies. Defense-in-depth
   *  safety net on top of the providers filter; 0 / undefined / negative
   *  values are normalised to DEFAULT_MAX_BODY_BYTES at construction so
   *  the rest of the code path can read this field unconditionally.
   *  Public-readonly because the WrappingDispatcher (same module, but a
   *  separate class) needs to read it to build the capCtx for the fetch
   *  path — the field is immutable after construction so external
   *  readers cannot perturb the cap. */
  public readonly maxBodyBytes: number;
  /** Optional structured callback fired exactly once per (host, direction)
   *  when the byte cap trips. Independent of the Logger seam — the
   *  Logger type still only accepts LlmLogEntry, and adding a second
   *  argument to that seam would silently widen its contract.
   *  Public-readonly for the same reason as `maxBodyBytes` above. */
  public readonly onBodyDropped: ((info: BodyDroppedInfo) => void) | undefined;

  private installed = false;

  /** Wrapping undici Dispatcher installed via `setGlobalDispatcher`. Set
   *  when the `undici` peer is installed AND install() ran; undefined
   *  when the peer is absent or install()/restore() cleared it. Typed as
   *  the interface (not the class) so the boundary into
   *  setGlobalDispatcher/getGlobalDispatcher is seamless; the wrapper
   *  carries the kDispatcherWrapper Symbol tag for runtime identity
   *  checks. */
  private dispatcherWrapper: UndiciDispatcher | undefined;
  /** The undici Dispatcher captured at install() time, reinstated by
   *  restore() via reference identity (===). Undefined when no undici
   *  patch is in effect. */
  private dispatcherOriginal: UndiciDispatcher | undefined;

  constructor(options: InterceptorOptions = {}) {
    this.providers = options.providers || DEFAULT_PROVIDERS;
    this.capturePayloads = options.capturePayloads ?? false;
    this.logger = options.logger || consoleLogger;
    this.tokenCounter = options.tokenCounter || {};
    this.providerParser = options.providerParser;
    this.redaction = options.redaction;
    this.requestTransform = options.requestTransform;
    this.responseTransform = options.responseTransform;
    // Normalise the byte cap: 0 / undefined / negative fall back to the
    // built-in default so downstream code can read `this.maxBodyBytes`
    // unconditionally without re-checking the input. Silently disabling
    // capture on 0 would be a foot-gun — the providers filter is the
    // privacy boundary, this is a safety net.
    this.maxBodyBytes =
      typeof options.maxBodyBytes === 'number' && options.maxBodyBytes > 0
        ? options.maxBodyBytes
        : DEFAULT_MAX_BODY_BYTES;
    this.onBodyDropped = options.onBodyDropped;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Patch both Node's `http.ClientRequest.prototype` (write/end/on) AND
   * undici's global dispatcher (via `setGlobalDispatcher`) so LLM traffic
   * arriving on either surface — `http.request`, `https.request`, or
   * `globalThis.fetch` (which is undici-backed in Node 18+) — flows through
   * the same `emitLogEntry` builder. https.ClientRequest IS
   * http.ClientRequest in Node; patching the prototype once covers both.
   *
   * Idempotent: a second `install()` on the same instance is a no-op
   * (`this.installed` guard). The undici side additionally checks the
   * `kDispatcherWrapper` tag on the current global dispatcher so a
   * double-install cannot stack a second wrapper.
   *
   * When the optional `undici` peer dep is absent at runtime, install()
   * still patches the http surface and silently skips the undici side.
   */
  install(): void {
    if (this.installed) {
      return;
    }
    this.patchPrototype(http.ClientRequest);
    this.installUndiciDispatcher();
    this.installed = true;
  }

  /**
   * Reinstate the pristine `http.ClientRequest.prototype` AND the original
   * undici global dispatcher (by reference identity). Idempotent: a
   * second `restore()` with no intervening `install()` is a no-op
   * (`this.installed` guard). When the undici peer is absent or the
   * wrapper is not currently the global dispatcher, restore() still
   * cleans up its stored references without throwing.
   */
  restore(): void {
    if (!this.installed) {
      return;
    }
    this.unpatchPrototype(http.ClientRequest);
    this.restoreUndiciDispatcher();
    this.installed = false;
  }

  /**
   * Install the wrapping undici Dispatcher as the process-global one.
   * Silent no-op when the `undici` peer dep is absent (zero-hard-deps
   * invariant: the lazy-require in module-top catches MODULE_NOT_FOUND
   * and leaves `undici` undefined).
   */
  private installUndiciDispatcher(): void {
    if (undici === undefined) {
      return;
    }
    // Idempotency via the kDispatcherWrapper tag: if the current global
    // dispatcher is already the wrapper we previously installed, skip.
    if (undici.getGlobalDispatcher() === this.dispatcherWrapper) {
      return;
    }
    const original = undici.getGlobalDispatcher();
    // Cast: at runtime WrappingDispatcher is a valid Dispatcher (extends
    // EventEmitter, has dispatch(), forwards the rest); TS cannot verify
    // this because EventEmitter's listeners() return type (Function[]) is
    // broader than Dispatcher's narrowed overload. undici's actual runtime
    // exercise of a global dispatcher uses only dispatch() and the
    // connect/disconnect emit events — both present and correctly typed.
    const wrapper = new WrappingDispatcher(
      original,
      this,
    ) as unknown as UndiciDispatcher;
    this.dispatcherOriginal = original;
    this.dispatcherWrapper = wrapper;
    undici.setGlobalDispatcher(wrapper);
  }

  /**
   * Reinstate the captured original undici Dispatcher. Reference-identity
   * guard: only reinstate when the current global dispatcher is still
   * our wrapper (some external code may have swapped the global between
   * install() and restore() — in that case we leave the external swap
   * intact and clear our stored refs).
   */
  private restoreUndiciDispatcher(): void {
    if (
      undici !== undefined &&
      this.dispatcherWrapper !== undefined &&
      this.dispatcherOriginal !== undefined &&
      undici.getGlobalDispatcher() === this.dispatcherWrapper
    ) {
      undici.setGlobalDispatcher(this.dispatcherOriginal);
    }
    this.dispatcherWrapper = undefined;
    this.dispatcherOriginal = undefined;
  }

  // ---------------------------------------------------------------------
  // Patching
  // ---------------------------------------------------------------------

  private patchPrototype(proto: typeof ClientRequest): void {
    const protoTag = tag(proto);
    const existingWrite = protoTag[kWriteWrapper];
    const existingEnd = protoTag[kEndWrapper];
    if (
      typeof existingWrite === 'function' &&
      typeof existingEnd === 'function'
    ) {
      // Already patched by this package: never stack a second wrapper.
      return;
    }

    // Capture the pristine methods as-is (no `.bind`). We MUST not bind:
    // a bound function ignores `.call(thisArg, ...)` and locks `this` to
    // the prototype, so `originalEnd.call(req, ...)` would call the body
    // with `this = proto.prototype`, not the actual ClientRequest — which
    // makes the real implementation crash on its first `this._header`
    // access. Calling the unbound original with `.call(this, ...)` sets
    // `this` to the actual instance exactly as Node expects.
    const originalWrite = proto.prototype.write;
    const originalEnd = proto.prototype.end;
    const origOn = proto.prototype.on;
    // `self` is the interceptor instance. no-this-alias is relaxed for this
    // file (see eslint.config.mjs) because monkey-patching
    // ClientRequest.prototype is inherently this-manipulating.
    const self = this;

    const onWrapper = function (
      this: ClientRequest,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): ClientRequest {
      if (event === 'error') {
        const tagged = tag(this);
        const capture = tagged[kCapture] as CaptureState | undefined;
        if (
          !capture &&
          !tagged[kNoCapture] &&
          shouldCapture(this, self.providers)
        ) {
          self.attachCapture(this, captureCallerTrace());
        } else if (!capture && !tagged[kNoCapture]) {
          tagged[kNoCapture] = true;
        }
      }
      return (origOn as (...args: unknown[]) => unknown).call(
        this,
        event,
        listener,
      ) as ClientRequest;
    };
    /** Attach-on-first-touch shared by write/end: returns the capture
     *  state when this request is (or becomes) captured, else tags the
     *  negative decision and returns undefined. */
    const captureFor = function (req: ClientRequest): CaptureState | undefined {
      const tagged = tag(req);
      const existing = tagged[kCapture] as CaptureState | undefined;
      if (existing !== undefined) {
        return existing;
      }
      if (tagged[kNoCapture]) {
        return undefined;
      }
      if (shouldCapture(req, self.providers)) {
        self.attachCapture(req, captureCallerTrace());
        return tagged[kCapture] as CaptureState;
      }
      tagged[kNoCapture] = true;
      return undefined;
    };
    const writeWrapper = function (
      this: ClientRequest,
      ...args: unknown[]
    ): boolean {
      const capture = captureFor(this);
      if (capture !== undefined) {
        appendChunk(capture.requestBodyChunks, args[0], encodingArg(args), {
          state: capture,
          direction: 'request',
          cap: self.maxBodyBytes,
          onDropped: self.onBodyDropped,
        });
        // Buffer-and-hold: with a transform configured, withhold the
        // chunk from the wire (holdWrite collects the uncapped wire copy
        // and schedules the caller's callback); the full body goes out
        // in one terminal write at end().
        if (
          self.requestTransform !== undefined &&
          holdWrite(this, capture, args)
        ) {
          return true;
        }
      }
      return reflectCall(
        originalWrite as unknown as ReflectFn,
        this,
        args,
      ) as boolean;
    };
    const endWrapper = function (
      this: ClientRequest,
      ...args: unknown[]
    ): ClientRequest {
      const capture = captureFor(this);
      if (capture !== undefined) {
        // end([chunk[, encoding]][, callback]) — a lone callback arg is
        // not a body chunk.
        if (args[0] !== undefined && typeof args[0] !== 'function') {
          appendChunk(capture.requestBodyChunks, args[0], encodingArg(args), {
            state: capture,
            direction: 'request',
            cap: self.maxBodyBytes,
            onDropped: self.onBodyDropped,
          });
        }
        capture.capturedEnd = true;
        capture.finished = true;
        if (self.requestTransform !== undefined) {
          const heldArgs = holdEnd(this, capture, self.requestTransform, args);
          if (heldArgs !== undefined) {
            return reflectCall(
              originalEnd as unknown as ReflectFn,
              this,
              heldArgs,
            ) as ClientRequest;
          }
        }
      }
      return reflectCall(
        originalEnd as unknown as ReflectFn,
        this,
        args,
      ) as ClientRequest;
    };

    Object.defineProperty(writeWrapper, 'name', { value: 'elenwatchWrite' });
    Object.defineProperty(endWrapper, 'name', { value: 'elenwatchEnd' });

    // Store the pristine originals on the wrappers themselves so restore()
    // can reinstate them by reference identity.
    tag(writeWrapper)[kWriteWrapper] = originalWrite;
    tag(endWrapper)[kEndWrapper] = originalEnd;
    tag(onWrapper)[kEndWrapper] = origOn;

    protoTag[kWriteWrapper] = writeWrapper;
    protoTag[kEndWrapper] = endWrapper;
    if (onWrapper) {
      protoTag[kOnWrapper] = onWrapper;
    }
    proto.prototype.write = writeWrapper as typeof proto.prototype.write;
    proto.prototype.end = endWrapper as typeof proto.prototype.end;
    if (onWrapper) {
      proto.prototype.on = onWrapper as typeof proto.prototype.on;
    }
  }

  private unpatchPrototype(proto: typeof ClientRequest): void {
    const protoTag = tag(proto);
    const writeWrapper = protoTag[kWriteWrapper];
    const endWrapper = protoTag[kEndWrapper];
    if (
      typeof writeWrapper === 'function' &&
      proto.prototype.write === writeWrapper
    ) {
      // The pristine original is captured on the wrapper's own tag.
      const originalWrite = tag(writeWrapper)[kWriteWrapper];
      if (typeof originalWrite === 'function') {
        proto.prototype.write = originalWrite as typeof proto.prototype.write;
      }
    }
    if (
      typeof endWrapper === 'function' &&
      proto.prototype.end === endWrapper
    ) {
      const originalEnd = tag(endWrapper)[kEndWrapper];
      if (typeof originalEnd === 'function') {
        proto.prototype.end = originalEnd as typeof proto.prototype.end;
      }
    }
    if (protoTag[kOnWrapper]) {
      const onWrapper = protoTag[kOnWrapper] as (...args: unknown[]) => unknown;
      if (proto.prototype.on === onWrapper) {
        const originalOn = tag(onWrapper)[kEndWrapper];
        if (typeof originalOn === 'function') {
          proto.prototype.on = originalOn as typeof proto.prototype.on;
        }
      }
      delete protoTag[kOnWrapper];
    }
    delete protoTag[kWriteWrapper];
    delete protoTag[kEndWrapper];
  }

  // ---------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------

  /** Attach capture bookkeeping to a request (with an optional probe). */
  attachCapture(req: ClientRequest, callerTrace?: string): void {
    const reqTag = tag(req);
    const existing = reqTag[kCapture] as CaptureState | undefined;
    if (existing) {
      return;
    }
    // Capture the destination host ONCE at attachCapture time so the
    // byte-cap code path can populate `onBodyDropped`'s `host` field
    // without reaching back to the (possibly released) req later. Uses
    // the same helper shouldCapture relies on so the host string the
    // operator sees in the dropped-event log matches the host string the
    // filter actually matched against.
    const host = reqHostname(req) ?? 'unknown';
    const state: CaptureState = {
      requestBodyChunks: [],
      responseBodyChunks: [],
      capturedEnd: false,
      finished: false,
      emitted: false,
      callerTrace: callerTrace ?? 'unknown',
      host,
      bytesCaptured: { request: 0, response: 0 },
      bodyDropped: { request: false, response: false },
    };
    reqTag[kCapture] = state;

    // Response capture: exactly the original semantics, off the request
    // path (the 'response' event is async by nature).
    req.on('response', (res: IncomingMessage) => {
      const byContentType = isSseResponse(res);
      if (byContentType) {
        this.attachSseCapture(req, state, res);
        return;
      }
      // No content-type signal. Only a chunked body without a
      // content-length could still be SSE: probe the leading lines of the
      // first data chunk(s) (bounded), promote to streaming on a
      // `data:`/`event:` shape, otherwise buffer as before.
      const knownLength =
        typeof res.headers?.['content-length'] === 'string' ||
        typeof res.headers?.['content-length'] === 'number';
      if (!knownLength) {
        let mode: 'probe' | 'sse' | 'buffered' = 'probe';
        let probeCarry = Buffer.alloc(0);
        let pastedProbe = false;
        const parser = this.makeStreamingParser(state);
        res.on('data', (chunk: Buffer) => {
          if (mode === 'sse') {
            state.streamResult = parser.feed(chunk);
            return;
          }
          if (mode === 'probe') {
            const probe = probeSseShape(chunk, {
              buffer: probeCarry,
              probed: pastedProbe,
            });
            probeCarry = Buffer.from(probe.carry.buffer);
            pastedProbe = probe.carry.probed;
            if (probe.sse) {
              mode = 'sse';
              state.isSse = true;
              state.streamParser = parser;
              // All carried head bytes (never discarded) feed the parser;
              // the current chunk was already folded into the head.
              state.streamResult = parser.feed(probeCarry);
              probeCarry = Buffer.alloc(0);
              return;
            }
            if (pastedProbe) {
              mode = 'buffered';
              // Not SSE: fall back to buffered capture with the FULL head
              // (the current chunk is already inside probeCarry).
              if (probeCarry.length > 0) {
                appendChunk(state.responseBodyChunks, probeCarry, undefined, {
                  state,
                  direction: 'response',
                  cap: this.maxBodyBytes,
                  onDropped: this.onBodyDropped,
                });
                probeCarry = Buffer.alloc(0);
              }
              return;
            }
            // Probe inconclusive (head < 2 lines and < 1KB): keep
            // accumulating; probeCarry is bounded (≤1KB + one chunk).
            return;
          }
          appendChunk(state.responseBodyChunks, chunk, undefined, {
            state,
            direction: 'response',
            cap: this.maxBodyBytes,
            onDropped: this.onBodyDropped,
          });
        });
        res.on('end', () => {
          // If the body ended while still probing, decide now: no SSE
          // shape -> flush the carry into the buffered path so nothing is
          // lost. (SSE would already have promoted on a shape match.)
          if (mode === 'probe' && probeCarry.length > 0) {
            appendChunk(state.responseBodyChunks, probeCarry, undefined, {
              state,
              direction: 'response',
              cap: this.maxBodyBytes,
              onDropped: this.onBodyDropped,
            });
            probeCarry = Buffer.alloc(0);
          }
          if (mode === 'sse' && state.streamParser) {
            // A promoted stream ending on an unterminated event: flush.
            state.streamResult = state.streamParser.flush();
          }
          state.finished = true;
          this.completeCapture(req, state);
        });
        res.on('error', () => {
          state.finished = true;
          this.completeCapture(req, state);
        });
        res.on('aborted', () => {
          state.finished = true;
          this.completeCapture(req, state);
        });
        res.on('close', () => {
          if (!state.finished) {
            state.finished = true;
            this.completeCapture(req, state);
          }
        });
        return;
      }
      res.on('data', (chunk: Buffer) => {
        appendChunk(state.responseBodyChunks, chunk, undefined, {
          state,
          direction: 'response',
          cap: this.maxBodyBytes,
          onDropped: this.onBodyDropped,
        });
      });
      res.on('end', () => {
        state.finished = true;
        this.completeCapture(req, state);
      });
    });

    req.on('error', (err) => {
      this.completeCapture(req, state, err);
    });
  }

  /** Build the per-event streaming pipeline (transform then redact, ADR §3). */
  private makeStreamingParser(
    state: CaptureState,
  ): ReturnType<typeof createEventStreamParser> {
    return createEventStreamParser((event) => {
      if (event.data === '') {
        return;
      }
      let data = event.data;
      const transform = this.responseTransform;
      if (transform !== undefined) {
        try {
          const out = transform(data);
          if (out !== undefined) {
            data = out;
          }
        } catch {
          // A throwing transform is passthrough (ADR §3).
        }
      }
      let eventJson: unknown;
      try {
        eventJson = JSON.parse(data) as unknown;
      } catch {
        eventJson = undefined;
      }
      if (this.capturePayloads && eventJson !== undefined) {
        if (state.redactedEvents === undefined) {
          state.redactedEvents = [];
        }
        state.redactedEvents.push(
          redact(eventJson, this.redaction, 'response'),
        );
      }
    });
  }

  /** Attach the bounded SSE capture path (content-type-signalled). */
  private attachSseCapture(
    req: ClientRequest,
    state: CaptureState,
    res: IncomingMessage,
  ): void {
    state.isSse = true;
    const parser = this.makeStreamingParser(state);
    state.streamParser = parser;
    res.on('data', (chunk: Buffer) => {
      state.streamResult = parser.feed(chunk);
    });
    res.on('end', () => {
      state.streamResult = parser.flush();
      state.finished = true;
      this.completeCapture(req, state);
    });
    res.on('error', () => {
      state.finished = true;
      this.completeCapture(req, state);
    });
    res.on('aborted', () => {
      state.finished = true;
      this.completeCapture(req, state);
    });
    res.on('close', () => {
      if (!state.finished) {
        state.finished = true;
        this.completeCapture(req, state);
      }
    });
  }

  /** Package-internal, not private: the fetch-path body observer
   *  (observeRequestBody) re-enters it to release a deferred terminal. */
  completeCapture(
    req: ClientRequest,
    state: CaptureState,
    error?: Error,
  ): void {
    // Exactly-once guard: response-end and error can both fire for one
    // request; only the first terminal signal may schedule emission.
    if (state.emitted) {
      return;
    }
    // Success terminal while the request-body observer is still draining
    // the caller's stream: park it — the observer's finally re-enters.
    // Error terminals emit immediately (a failed request's body never
    // completes, and the error entry may carry a partial capture).
    if (state.requestStreamPending === true && error === undefined) {
      state.deferredTerminal = true;
      return;
    }
    state.emitted = true;
    // Deferred emission: never on the synchronous request path.
    setImmediate(() => {
      try {
        this.emitLogEntry(req, state, error);
      } catch {
        // A throwing pluggable callback (providerParser / tokenCounter /
        // logger) in the deferred path must never crash the process.
      }
    });
  }

  // ---------------------------------------------------------------------
  // Log entry assembly
  // ---------------------------------------------------------------------

  private emitLogEntry(
    req: ClientRequest,
    state: CaptureState,
    error?: Error,
  ): void {
    const rawRequest = state.transformedBody
      ? state.transformedBody
      : Buffer.concat(state.requestBodyChunks).toString('utf8');
    // Streaming path: never accumulate the body; responseJson is undefined
    // (the parser's StreamingResult carries the real numbers) and
    // maskedResponseBody comes from the bounded per-event redaction store.
    let responseJson: unknown;
    if (state.isSse) {
      responseJson = undefined;
    } else {
      const rawResponse = Buffer.concat(state.responseBodyChunks).toString(
        'utf8',
      );
      if (rawResponse) {
        try {
          responseJson = JSON.parse(rawResponse);
        } catch {
          responseJson = undefined;
        }
      }
    }

    let requestJson: unknown;
    if (rawRequest) {
      try {
        requestJson = JSON.parse(rawRequest);
      } catch {
        requestJson = undefined;
      }
    }

    const url = deriveUrl(req, resolveScheme(req));
    const callerTrace = state.callerTrace || 'unknown';

    // Parse step: route through the default parser. A caller-supplied
    // providerParser fully replaces it; otherwise defaultParser runs.
    // Legacy `tokenCounter` overrides hook into the parser's individual
    // hooks when supplied.
    const parser = this.providerParser ?? defaultParser;
    const tokenCounter = this.tokenCounter;
    const effectiveParser: ProviderParser =
      tokenCounter.estimateInputTokens || tokenCounter.extractOutputTokens
        ? {
            extractModel: parser.extractModel,
            estimateInputTokens: (b) =>
              tokenCounter.estimateInputTokens
                ? tokenCounter.estimateInputTokens(b)
                : parser.estimateInputTokens(b),
            extractOutputTokens: (b) =>
              tokenCounter.extractOutputTokens
                ? tokenCounter.extractOutputTokens(b)
                : parser.extractOutputTokens(b),
          }
        : parser;
    let parsed: ParseResult;
    if (state.isSse && state.streamResult) {
      const sr = state.streamResult;
      // On the SSE path the entry's model and output tokens come from the
      // merged incremental parser's StreamingResult — never 'unknown'/0
      // when the stream carried them. Input tokens: the usage-bearing
      // event's input count wins (OpenAI prompt_tokens / Anthropic
      // message_start input_tokens); fall back to the request-parse
      // estimate when the stream carried no usage.
      const requestEstimate = effectiveParser.estimateInputTokens(requestJson);
      parsed = {
        model: sr.model,
        inputTokens: sr.inputTokens > 0 ? sr.inputTokens : requestEstimate,
        outputTokens: error ? 0 : sr.outputTokens,
      };
    } else {
      parsed = parseCall(
        effectiveParser,
        requestJson,
        responseJson,
        Boolean(error),
      );
    }

    const entry: LlmLogEntry = {
      timestamp: new Date(),
      model: parsed.model,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      callerTrace,
      url,
    };
    if (this.capturePayloads) {
      if (requestJson !== undefined) {
        entry.maskedRequestBody = redact(
          requestJson,
          this.redaction,
          'request',
        );
      }
      if (state.isSse) {
        // Per-event redacted JSON, bounded accumulator (never the stream).
        if (state.redactedEvents !== undefined) {
          entry.maskedResponseBody =
            state.redactedEvents.length === 1
              ? state.redactedEvents[0]
              : state.redactedEvents;
        }
      } else if (responseJson !== undefined) {
        entry.maskedResponseBody = redact(
          responseJson,
          this.redaction,
          'response',
        );
      }
    }
    if (error) {
      entry.error = {
        message: error.message,
        name: error.name,
        stack: error.stack,
      };
    }

    try {
      this.logger(entry);
    } catch {
      // A throwing logger must never break the intercepted call.
    }
  }
}

type ReflectFn = (this: unknown, ...a: unknown[]) => unknown;

/**
 * Forward an intercepted write/end call to the original implementation,
 * preserving the exact arity/overload Node's runtime dispatch expects
 * (it branches on argument types, not on named parameters).
 */
function reflectCall(
  original: ReflectFn,
  receiver: unknown,
  args: unknown[],
): any {
  // Forward the intercepted call to the pristine original with the exact
  // argument list the caller used — never reconstruct a subset. Node's
  // runtime dispatch branches on argument types (chunk, encoding,
  // callback), so dropping a positional arg (e.g. encoding when a
  // callback is also present) would silently corrupt the request.
  return original.apply(receiver, args);
}

/**
 * Detect an SSE event-stream response. Primary signal: content-type
 * `text/event-stream`. Secondary signal: the `data:`/`event:` line shape
 * in a bounded probe of the first two leading lines of the body — used
 * only when content-type is absent or ambiguous (and no content-length
 * proves a fully-buffered body). A non-SSE chunked body merely containing
 * `data:` text later in the stream cannot false-positive because the probe
 * is bounded and happens before buffering. Responses that fail both
 * signals keep the pre-horizon buffered behavior.
 */
export function isSseResponse(res: IncomingMessage): boolean {
  const headers = res.headers ?? {};
  const contentType =
    typeof headers['content-type'] === 'string'
      ? headers['content-type'].toLowerCase()
      : '';
  if (contentType.includes('text/event-stream')) {
    return true;
  }
  // Content-type absent/other: only probe the shape when the body is not
  // provably a single fully-buffered unit (a known content-length).
  const knownLength =
    typeof headers['content-length'] === 'string' ||
    typeof headers['content-length'] === 'number';
  if (knownLength) {
    return false;
  }
  void contentType;
  return false;
}

/**
 * Probe a chunk's leading bytes for the SSE line shape (`data:` or
 * `event:` prefix on the first or second line). Bounded probe — reads at
 * most the first two lines from the head of the stream, so it cannot
 * accumulate the body. Returns true only when the shape matches AND no
 * content-length was present (callers gate this). The state carries the
 * probe buffer so a `data:` line split across the first chunks still
 * matches.
 */
export function probeSseShape(
  chunk: Buffer,
  carry?: { buffer: Buffer; probed: boolean },
): { sse: boolean; carry: { buffer: Buffer; probed: boolean } } {
  // Never discard bytes: the carry accumulates the head until the decision
  // is made, and is capped at 1KB so it stays bounded. All carried bytes are
  // always handed to whoever owns them next (buffered path or SSE parser).
  const head = carry?.buffer ? Buffer.concat([carry.buffer, chunk]) : chunk;
  const probe = head.subarray(0, Math.min(head.length, 1024));
  const text = probe.toString('utf8');
  // SSE line shape: a `data:` or `event:` prefix on the first line, or a
  // second line after a blank/comment (real SSE transcripts start with
  // `data:` on the very first line, so the first-line check is the strong
  // signal; the second line only matters for BOM/comment-prefixed streams).
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const secondLine =
    nl === -1
      ? ''
      : text.slice(
          nl + 1,
          text.indexOf('\n', nl + 1) === -1
            ? text.length
            : text.indexOf('\n', nl + 1),
        );
  const sse =
    firstLine.startsWith('data:') ||
    firstLine.startsWith('event:') ||
    secondLine.startsWith('data:') ||
    secondLine.startsWith('event:');
  // Decision is final once either the probe cap is reached OR two complete
  // lines are available (a line's terminator proves SSE can't appear later
  // than line 2 for the provider transcripts we target).
  const twoComplete =
    (nl !== -1 && text.indexOf('\n', nl + 1) !== -1) || text.includes('\n\n');
  const decided = probe.length >= 1024 || twoComplete;
  return {
    sse,
    carry: {
      // Keep the FULL head (not just the unprobed tail): the caller needs
      // every byte for the buffered path; the probe only reads them.
      buffer: head,
      probed: decided,
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * The synthetic ClientRequest's getHeader implementation.
 *
 * Returns the value of `name` from the lowercased header map. For the
 * `host` key only, falls back to `hostHeader` when the header is not in
 * the map — preserving the behaviour deriveUrl and reqHostname rely on.
 *
 * Returns `undefined` for any other absent key. The previous
 * implementation fell back to `hostHeader` for ANY absent header, which
 * was a header-lie trap: a request with no `content-length` would have
 * silently returned a host-looking string instead of `undefined`. Today
 * only `host` is read in-file, so the lie was invisible — but any
 * downstream reader of any other header (content-length, content-type,
 * transfer-encoding, …) would get garbage. The fix narrows the
 * fallback to the single key elenwatch itself depends on.
 */
export function syntheticGetHeader(
  name: string,
  headersLower: ReadonlyMap<string, string>,
  hostHeader: string,
): string | undefined {
  const v = headersLower.get(name.toLowerCase());
  if (v !== undefined) return v;
  return name.toLowerCase() === 'host' ? hostHeader : undefined;
}

/**
 * Whether a request's host should be captured. Exact host, subdomain
 * suffix, or a regex from the options.
 */
export function shouldCapture(
  req: ClientRequest,
  providers: readonly (string | RegExp)[],
): boolean {
  const hostname = reqHostname(req)?.toLowerCase();
  if (!hostname) {
    return false;
  }
  return providers.some((pattern) => {
    if (typeof pattern === 'string') {
      const p = pattern.toLowerCase();
      return hostname === p || hostname.endsWith(`.${p}`);
    }
    return pattern.test(hostname);
  });
}

/** hostname of a request, from its own options (set by Node at build). */
function reqHostname(req: ClientRequest): string | undefined {
  const hostname =
    (req as unknown as Tagged & { hostname?: string }).hostname ??
    (typeof req.getHeader === 'function'
      ? req.getHeader('host')?.toString().split(':')[0]
      : undefined);
  return hostname || undefined;
}

/** Resolve the URL scheme for a request: https when TLS-backed, else http. */
export function resolveScheme(req: ClientRequest): 'http' | 'https' {
  const view = req as unknown as {
    protocol?: string;
    agent?: { protocol?: string };
    socket?: { encrypted?: boolean } | null;
    connection?: { encrypted?: boolean } | null;
  };
  if (view.protocol === 'https:') {
    return 'https';
  }
  if (view.agent?.protocol === 'https:') {
    return 'https';
  }
  if (view.socket?.encrypted === true || view.connection?.encrypted === true) {
    return 'https';
  }
  return 'http';
}

/** Derive the absolute url for a captured request. Scheme = entry type. */
export function deriveUrl(
  req: ClientRequest,
  scheme: 'http' | 'https' = 'http',
): string {
  const view = req as unknown as Tagged & {
    hostname?: string;
    port?: number | string;
    path?: string;
    socket?: { localPort?: number };
  };
  // The host header (if present) carries host[:port] authoritatively —
  // prefer it over `view.hostname` so a port-bearing header always wins
  // over a hostname-only view (the undici-patch synthetic ClientRequest
  // exposes both, and dropping the port when the header has one is wrong).
  const hostHeader =
    typeof req.getHeader === 'function'
      ? req.getHeader('host')?.toString()
      : undefined;
  const hostWithPort = (hostHeader ?? view.hostname ?? 'localhost').replace(
    /^\[|\]$/g,
    '',
  ); // strip IPv6 brackets for hostname comparisons
  let port = view.port;
  if ((port === undefined || port === '') && hostHeader?.includes(':')) {
    const hp = hostHeader.split(':');
    port = hp[1] ?? undefined;
  }
  const p =
    port === undefined || port === '' || port === null
      ? undefined
      : String(port);
  const defaultPort = scheme === 'https' ? '443' : '80';
  // The host header already carries host[:port]; only append the port when
  // we know it is NOT already present (avoid 127.0.0.1:63388:63388).
  const hostAlreadyHasPort = hostHeader?.includes(':') === true;
  const hostPart =
    p === undefined || p === defaultPort || hostAlreadyHasPort
      ? hostWithPort
      : `${hostWithPort}:${p}`;

  const path = view.path ?? '/';
  return `${scheme}://${hostPart}${path}`;
}

/**
 * The caller trace: the first stack frame above the interceptor's own
 * internals, node_modules, and node internals the request flows through.
 */
export function captureCallerTrace(): string {
  const stack = new Error().stack;
  if (!stack) {
    return 'unknown';
  }
  const lines = stack.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    // Skip our own module and any node-internal / node_modules frame.
    if (
      line.includes('elenwatch') ||
      line.includes('node_modules') ||
      line.includes('node:') ||
      line.includes('internal/')
    ) {
      continue;
    }
    // Skip JS-internal frames that carry no filename (e.g. `at new Promise
    // (<anonymous>)`, `at processTicksAndRejections (<anonymous>)`).
    if (/\(\s*<anonymous>\s*\)/.test(line) || line.includes('(<anonymous>)')) {
      continue;
    }
    // A real frame: names a file path with a line/col, or a .ts/.js/.mjs
    // path (including inside parens). This catches both `at file:1:2` and
    // `at fn (file:1:2)` forms while still skipping `<anonymous>`.
    if (
      /\.(ts|js|mjs|cjs|tsx|jsx):\d+/.test(line) ||
      /\(.+\.(ts|js|mjs|cjs|tsx|jsx):\d+/.test(line)
    ) {
      return line;
    }
  }
  return 'unknown';
}
