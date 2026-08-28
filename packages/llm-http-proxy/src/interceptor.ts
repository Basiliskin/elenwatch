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
import { InterceptorOptions, LlmLogEntry, TokenCounter } from './options';

const DEFAULT_PROVIDERS: string[] = [
  'api.openai.com',
  'api.anthropic.com',
  'api.cohere.ai',
  'api.mistral.ai',
];


/** Payload bookkeeping attached to a ClientRequest whose url is captured. */
interface CaptureState {
  requestBodyChunks: string[];
  responseBodyChunks: string[];
  capturedEnd: boolean;
  finished: boolean;
  /** Caller trace captured SYNCHRONOUSLY at write/end time (the async
   *  emission path loses the caller stack). */
  callerTrace: string;
}

const kCapture = Symbol('llm-http-proxy.capture');

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

function appendChunk(chunks: string[], chunk: unknown): void {
  if (chunk === null || chunk === undefined) {
    return;
  }
  if (typeof chunk === 'string') {
    chunks.push(chunk);
  } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    chunks.push(Buffer.from(chunk as Uint8Array).toString('utf8'));
  } else if (typeof chunk === 'object' || typeof chunk === 'function') {
    try {
      chunks.push(JSON.stringify(chunk));
    } catch {
      chunks.push('<unserializable>');
    }
  } else {
    chunks.push(String(chunk));
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
  private readonly logger: (entry: LlmLogEntry) => void;
  private readonly tokenCounter: TokenCounter;

  private installed = false;

  constructor(options: InterceptorOptions = {}) {
    this.providers = options.providers || DEFAULT_PROVIDERS;
    this.capturePayloads = options.capturePayloads ?? false;
    this.logger =
      options.logger || ((entry) => console.log(JSON.stringify(entry)));
    this.tokenCounter = options.tokenCounter || {};
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

    const originalWrite = proto.prototype.write;
    const originalEnd = proto.prototype.end;
    const origOn = proto.prototype.on;
    const self = this;

    // Error-path capture: a refused connection may never call write/end.
    // Hook 'on' so attaching an 'error' listener also latches capture when
    // the request matches. (Non-matching requests stay untouched.)
    const onWrapper = function (
      this: ClientRequest,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ): ClientRequest {
      if (event === 'error') {
        const tagged = tag(this);
        const capture = tagged[kCapture] as CaptureState | undefined;
        if (!capture && shouldCapture(this, self.providers)) {
          self.attachCapture(this, captureCallerTrace());
        }
      }
      return origOn.call(this, event, listener);
    };

    const writeWrapper = function (
      this: ClientRequest,
      ...args: unknown[]
    ): boolean {
      const tagged = tag(this);
      const capture = tagged[kCapture] as CaptureState | undefined;
      if (capture !== undefined) {
        appendChunk(capture.requestBodyChunks, args[0]);
      } else if (shouldCapture(this, self.providers)) {
        self.attachCapture(this, captureCallerTrace());
        const state = tagged[kCapture] as CaptureState;
        appendChunk(state.requestBodyChunks, args[0]);
      }
      return reflectCall(
        originalWrite as unknown as ReflectFn,
        this,
        args,
        args[0] as string | Buffer,
      );
    };
    const endWrapper = function (
      this: ClientRequest,
      ...args: unknown[]
    ): ClientRequest {
      const tagged = tag(this);
      const capture = tagged[kCapture] as CaptureState | undefined;
      if (capture !== undefined) {
        if (args[0] !== undefined) {
          appendChunk(capture.requestBodyChunks, args[0]);
        }
        capture.capturedEnd = true;
        capture.finished = true;
      } else if (shouldCapture(this, self.providers)) {
        self.attachCapture(this, captureCallerTrace());
        const state = tagged[kCapture] as CaptureState;
        if (args[0] !== undefined) {
          appendChunk(state.requestBodyChunks, args[0]);
        }
        state.capturedEnd = true;
        state.finished = true;
      }
      return reflectCall(
        originalEnd as unknown as ReflectFn,
        this,
        args,
        args[0] as string | Buffer | undefined,
      );
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
    // Deferred emission: never on the synchronous request path.
    setImmediate(() => {
      this.emitLogEntry(req, state, error);
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
    const rawRequest = state.requestBodyChunks.join('');
    const rawResponse = state.responseBodyChunks.join('');

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

    const url = deriveUrl(req);
    const callerTrace = state.callerTrace || 'unknown';

    const requestObj = requestJson as Record<string, unknown> | undefined;
    const modelValue = requestObj?.model ?? requestObj?.model_name;
    const model = typeof modelValue === 'string' ? modelValue : 'unknown';
    const inputTokens = this.estimateInputTokens(requestJson);
    const outputTokens = error ? 0 : this.extractOutputTokens(responseJson);

    const entry: LlmLogEntry = {
      timestamp: new Date(),
      model,
      inputTokens,
      outputTokens,
      callerTrace,
      url,
    };
    if (this.capturePayloads) {
      if (requestJson !== undefined) {
        entry.maskedRequestBody = requestJson;
      }
      if (responseJson !== undefined) {
        entry.maskedResponseBody = responseJson;
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

  private estimateInputTokens(requestJson: unknown): number {
    const custom = this.tokenCounter.estimateInputTokens;
    if (custom) {
      return custom(requestJson);
    }
    return defaultEstimateInputTokens(requestJson);
  }

  private extractOutputTokens(responseJson: unknown): number {
    const custom = this.tokenCounter.extractOutputTokens;
    if (custom) {
      return custom(responseJson);
    }
    return defaultExtractOutputTokens(responseJson);
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
  chunk: string | Buffer | undefined,
): any {
  const rest = args.slice(1) as [
    string | undefined,
    ((error?: Error | null) => void) | undefined,
  ];
  const encoding = rest[0];
  const callback = rest[1];
  if (callback !== undefined) {
    return original.call(receiver, chunk, callback);
  }
  if (encoding !== undefined) {
    return original.call(receiver, chunk, encoding);
  }
  return original.call(receiver, chunk);
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

/**
 * Default input-token heuristic: ceil(chars / 4) over the messages/prompt/
 * input text. Mirrors the original implementation.
 */
export function defaultEstimateInputTokens(requestJson: unknown): number {
  const obj = requestJson as Record<string, unknown> | undefined;
  if (!obj) {
    return 0;
  }
  let text = '';
  if (Array.isArray(obj.messages)) {
    text = obj.messages
      .map((m) => {
        const message = m as Record<string, unknown>;
        return typeof message.content === 'string' ? message.content : '';
      })
      .join(' ');
  } else if (typeof obj.prompt === 'string') {
    text = obj.prompt;
  } else if (typeof obj.input === 'string') {
    text = obj.input;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Default output-token extraction: OpenAI usage.completion_tokens wins over
 * Anthropic usage.output_tokens; falls back to ceil(chars / 4) over the
 * choices/completion/output_text content.
 */
export function defaultExtractOutputTokens(responseJson: unknown): number {
  const obj = responseJson as Record<string, unknown> | undefined;
  if (!obj) {
    return 0;
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.completion_tokens === 'number') {
    return usage.completion_tokens;
  }
  if (usage && typeof usage.output_tokens === 'number') {
    return usage.output_tokens;
  }
  let text = '';
  if (Array.isArray(obj.choices)) {
    text = obj.choices
      .map((c) => {
        const choice = c as Record<string, unknown>;
        const message = choice.message as Record<string, unknown> | undefined;
        if (typeof message?.content === 'string') {
          return message.content;
        }
        return typeof choice.text === 'string' ? choice.text : '';
      })
      .join(' ');
  } else if (typeof obj.completion === 'string') {
    text = obj.completion;
  } else if (typeof obj.output_text === 'string') {
    text = obj.output_text;
  }
  return Math.ceil(text.length / 4);
}
