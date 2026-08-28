/**
 * llm-http-proxy interceptor core.
 *
 * Captures in-process LLM provider HTTP/HTTPS traffic by patching
 * `http.ClientRequest.prototype.write/end` once process-wide (singleton
 * guarded). Patching the prototype — rather than the `http.request` /
 * `https.request` exports — is the only interception point that works in
 * both real Node (where those exports are writable data properties) and
 * under a frozen module registry like Jest's (where they are non-writable
 * accessors); Node's own `request` constructs a `ClientRequest` and every
 * write/end flows through the prototype.
 *
 * Latency discipline: the original write/end forward through synchronously
 * first; payload capture and emission are deferred to response listeners /
 * a setImmediate callback, never on the synchronous request path.
 */

import { ClientRequest, IncomingMessage } from 'node:http';
import * as http from 'node:http';
import {
  ParseResult,
  ProviderParser,
  defaultParser,
  parseCall,
} from './provider-parser';
import { Logger, consoleLogger } from './logger';
import { RedactionConfig, redact } from './redaction';
import {
  InterceptorOptions,
  LlmLogEntry,
  RequestTransformer,
  TokenCounter,
} from './options';

const DEFAULT_PROVIDERS: string[] = [
  'api.openai.com',
  'api.anthropic.com',
  'api.cohere.ai',
  'api.mistral.ai',
];

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
}

const kCapture = Symbol('llm-http-proxy.capture');
// Negative capture-decision cache: once shouldCapture says false for a
// request, the tag is set and every wrapper short-circuits without re-
// running the decision. Scoped to the request instance, so it cannot go
// stale (hostname is fixed after construction) and restore() needs no
// cleanup.
const kNoCapture = Symbol('llm-http-proxy.noCapture');

// Install guard stored on the prototype itself: a second Interceptor (or a
// second install()) can never stack a second write/end wrapper.
const kWriteWrapper = Symbol('llm-http-proxy.writeWrapper');
const kEndWrapper = Symbol('llm-http-proxy.endWrapper');
const kOnWrapper = Symbol('llm-http-proxy.onWrapper');

type Tagged = Record<symbol, unknown>;

/** Treat an object as a symbol-keyed bag (symbols cannot collide). */
function tag(target: object): Tagged {
  return target as unknown as Tagged;
}

function appendChunk(
  chunks: Buffer[],
  chunk: unknown,
  encoding?: string,
): void {
  if (chunk === null || chunk === undefined) {
    return;
  }
  if (typeof chunk === 'string') {
    // Keep the raw bytes so a multi-byte character split across two
    // chunks is not corrupted by per-chunk decoding: the final UTF-8
    // decode happens exactly once, on the concatenated buffer.
    chunks.push(Buffer.from(chunk, encoding as BufferEncoding));
  } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  } else if (typeof chunk === 'object' || typeof chunk === 'function') {
    try {
      chunks.push(Buffer.from(JSON.stringify(chunk), 'utf8'));
    } catch {
      chunks.push(Buffer.from('<unserializable>', 'utf8'));
    }
  } else {
    // Primitive (number | boolean | bigint | symbol): safe, and the type
    // guard above already excluded objects, so String() cannot produce the
    // `[object Object]` leak the lint rule guards against.
    chunks.push(Buffer.from(String(chunk), 'utf8'));
  }
}

/** Extract the optional encoding argument from a write/end arg list. */
function encodingArg(args: unknown[]): string | undefined {
  return typeof args[1] === 'string' ? args[1] : undefined;
}

/**
 * Run the request transform exactly once over the full concatenated capture
 * at the terminal write/end, per the slice-spec ADR. When the transformer
 * actually replaces the body, `args[0]` is rewritten so the transformed bytes
 * hit the wire, the log entry reflects them, and Content-Length is set from
 * Buffer.byteLength(..., 'utf8') — but ONLY when a Content-Length header is
 * already present (chunked / gzip / absent-header requests pass through
 * untouched, and a no-op/undefined transform never rewrites the header).
 */
function applyRequestTransform(
  req: ClientRequest,
  state: CaptureState,
  transform: RequestTransformer,
  args: unknown[],
): void {
  if (state.requestBodyChunks.length === 0) {
    return;
  }
  const original = Buffer.concat(state.requestBodyChunks).toString('utf8');
  let replaced: string | undefined;
  try {
    replaced = transform(original);
  } catch {
    // A throwing transform forwards the original unchanged (ADR §3).
    replaced = undefined;
  }
  if (replaced === undefined || replaced === original) {
    return;
  }
  state.transformedBody = replaced;
  args[0] = Buffer.from(replaced, 'utf8');
  const header = (req as unknown as { getHeader?: (n: string) => unknown })
    .getHeader;
  const existing =
    typeof header === 'function'
      ? header.call(req, 'content-length')
      : undefined;
  if (existing !== undefined) {
    (
      req as unknown as {
        setHeader?: (n: string, v: string | number) => void;
      }
    ).setHeader?.call(
      req,
      'content-length',
      Buffer.byteLength(replaced, 'utf8'),
    );
  }
}

/**
 * The Nest-free, singleton-safe payload-capturing interceptor.
 *
 * ```
 * const interceptor = new Interceptor(options);
 * interceptor.install();   // patch ClientRequest.prototype (no-op if already installed)
 * // ... app runs ...
 * interceptor.restore();   // reinstate originals (idempotent)
 * ```
 */
export class Interceptor {
  private readonly providers: (string | RegExp)[];
  private readonly capturePayloads: boolean;
  private readonly logger: Logger;
  private readonly tokenCounter: TokenCounter;
  private readonly providerParser: ProviderParser | undefined;
  private readonly redaction: RedactionConfig | undefined;
  private readonly requestTransform: RequestTransformer | undefined;

  private installed = false;

  constructor(options: InterceptorOptions = {}) {
    this.providers = options.providers || DEFAULT_PROVIDERS;
    this.capturePayloads = options.capturePayloads ?? false;
    this.logger = options.logger || consoleLogger;
    this.tokenCounter = options.tokenCounter || {};
    this.providerParser = options.providerParser;
    this.redaction = options.redaction;
    this.requestTransform = options.requestTransform;
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  /** Patch ClientRequest.prototype.write/end. No-op when the patch is ours. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.patchPrototype(http.ClientRequest);
    // https.ClientRequest IS http.ClientRequest in Node; https only swaps
    // the transport. Patching once covers both.
    this.installed = true;
  }

  /** Reinstate the pristine write/end. Idempotent. */
  restore(): void {
    if (!this.installed) {
      return;
    }
    this.unpatchPrototype(http.ClientRequest);
    this.installed = false;
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
    const writeWrapper = function (
      this: ClientRequest,
      ...args: unknown[]
    ): boolean {
      const tagged = tag(this);
      const capture = tagged[kCapture] as CaptureState | undefined;
      if (capture !== undefined) {
        appendChunk(capture.requestBodyChunks, args[0], encodingArg(args));
      } else if (!tagged[kNoCapture] && shouldCapture(this, self.providers)) {
        self.attachCapture(this, captureCallerTrace());
        const state = tagged[kCapture] as CaptureState;
        appendChunk(state.requestBodyChunks, args[0], encodingArg(args));
      } else if (!tagged[kNoCapture]) {
        tagged[kNoCapture] = true;
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
      const tagged = tag(this);
      const capture = tagged[kCapture] as CaptureState | undefined;
      if (capture !== undefined) {
        if (args[0] !== undefined) {
          appendChunk(capture.requestBodyChunks, args[0], encodingArg(args));
        }
        capture.capturedEnd = true;
        capture.finished = true;
        if (self.requestTransform !== undefined) {
          applyRequestTransform(this, capture, self.requestTransform, args);
        }
      } else if (!tagged[kNoCapture] && shouldCapture(this, self.providers)) {
        self.attachCapture(this, captureCallerTrace());
        const state = tagged[kCapture] as CaptureState;
        if (args[0] !== undefined) {
          appendChunk(state.requestBodyChunks, args[0], encodingArg(args));
        }
        state.capturedEnd = true;
        state.finished = true;
        if (self.requestTransform !== undefined) {
          applyRequestTransform(this, state, self.requestTransform, args);
        }
      } else if (!tagged[kNoCapture]) {
        tagged[kNoCapture] = true;
      }
      return reflectCall(
        originalEnd as unknown as ReflectFn,
        this,
        args,
      ) as ClientRequest;
    };

    Object.defineProperty(writeWrapper, 'name', { value: 'llmHttpProxyWrite' });
    Object.defineProperty(endWrapper, 'name', { value: 'llmHttpProxyEnd' });

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
    const state: CaptureState = {
      requestBodyChunks: [],
      responseBodyChunks: [],
      capturedEnd: false,
      finished: false,
      emitted: false,
      callerTrace: callerTrace ?? 'unknown',
    };
    reqTag[kCapture] = state;

    // Response capture: exactly the original semantics, off the request
    // path (the 'response' event is async by nature).
    req.on('response', (res: IncomingMessage) => {
      res.on('data', (chunk: Buffer) => {
        appendChunk(state.responseBodyChunks, chunk);
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

  private completeCapture(
    req: ClientRequest,
    state: CaptureState,
    error?: Error,
  ): void {
    // Exactly-once guard: response-end and error can both fire for one
    // request; only the first terminal signal may schedule emission.
    if (state.emitted) {
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
    const rawResponse = Buffer.concat(state.responseBodyChunks).toString(
      'utf8',
    );

    let requestJson: unknown;
    let responseJson: unknown;
    if (rawRequest) {
      try {
        requestJson = JSON.parse(rawRequest);
      } catch {
        requestJson = undefined;
      }
    }
    if (rawResponse) {
      try {
        responseJson = JSON.parse(rawResponse);
      } catch {
        responseJson = undefined;
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
    const parsed: ParseResult = parseCall(
      effectiveParser,
      requestJson,
      responseJson,
      Boolean(error),
    );

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
      if (responseJson !== undefined) {
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

// ---------------------------------------------------------------------------
// Module-level helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Whether a request's host should be captured. Exact host, subdomain
 * suffix, or a regex from the options.
 */
export function shouldCapture(
  req: ClientRequest,
  providers: (string | RegExp)[],
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
  // The host header (if present) carries host[:port] authoritatively.
  const hostHeader =
    typeof req.getHeader === 'function'
      ? req.getHeader('host')?.toString()
      : undefined;
  const hostWithPort = (view.hostname ?? hostHeader ?? 'localhost').replace(
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
      line.includes('llm-http-proxy') ||
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
