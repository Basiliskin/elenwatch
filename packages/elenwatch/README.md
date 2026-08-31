# elenwatch

Near-zero-latency interception of in-process LLM provider HTTP/HTTPS traffic, with
pluggable loggers, per-provider parsers, request/response transformers, and payload
redaction.

`elenwatch` patches Node's HTTP client (`http.ClientRequest.prototype`) and the global
`undici` dispatcher that powers `fetch`, so outgoing calls to LLM provider hosts are
observed in-process without a proxy, a sidecar, or an extra network hop. Each intercepted
call produces one structured log entry that you route wherever you like.

- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [API](#api)

## Installation

```sh
npm install elenwatch
```

`elenwatch` has **no mandatory runtime dependencies**. Two capabilities depend on
*optional* peer dependencies that you install yourself only if you need them:

| Peer | Needed for | If absent |
| --- | --- | --- |
| `undici` | Capturing global `fetch()` traffic (Node's `fetch` is backed by `undici`). | Global `fetch` capture is **silently skipped** — no error is thrown. `http` / `https` module traffic is still intercepted. |
| `@opentelemetry/api` | The `otelSpanLogger` export, which turns each log entry into an OpenTelemetry span. | `otelSpanLogger` is inert (a no-op). Every other logger works normally. |

```sh
# only if you want fetch() capture
npm install undici

# only if you want the OpenTelemetry span logger
npm install @opentelemetry/api
```

These are declared as `peerDependencies` with `peerDependenciesMeta.optional = true`, so
your package manager will not install them automatically and will not warn when they are
missing.

## Quick start

```ts
import { Interceptor } from 'elenwatch';

const interceptor = new Interceptor({
  logger: (entry) => {
    console.log(JSON.stringify(entry));
  },
});

interceptor.install(); // start intercepting in-process LLM calls

// ...run your LLM requests (openai SDK, anthropic SDK, raw fetch, ...)...

interceptor.restore(); // stop intercepting (idempotent)
```

By default the emitted entry carries **no request or response body** — see
[`capturePayloads`](#capturepayloads) to opt in, and [redaction](#redaction) for how
bodies are masked when you do.

## Configuration

All options are passed to the `Interceptor` constructor and are optional:

```ts
new Interceptor({
  providers,          // (string | RegExp)[]      — hosts to intercept
  capturePayloads,    // boolean                  — default false
  logger,             // (entry: LlmLogEntry) => void
  tokenCounter,       // { estimateInputTokens?, extractOutputTokens? }
  providerParser,     // ProviderParser
  redaction,          // RedactionConfig
  requestTransform,   // (requestBody: string) => string | undefined
  responseTransform,  // (responseBody: string) => string | undefined
  maxBodyBytes,       // number (bytes)           — default 10 * 1024 * 1024
  onBodyDropped,      // (info: BodyDroppedInfo) => void
});
```

### Options reference

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `providers` | `(string \| RegExp)[]` | common LLM provider hosts | Hostnames (exact or subdomain suffix) or regexes to intercept. Traffic to any other host is ignored. |
| `capturePayloads` | `boolean` | `false` | When `false`, the entry carries no body content at all. When `true`, redacted bodies are attached as `maskedRequestBody` / `maskedResponseBody`. |
| `logger` | `(entry: LlmLogEntry) => void` | `console.log(JSON.stringify(entry))` | The emission sink. Called once per intercepted call (and once on the error path). Must not throw. |
| `tokenCounter` | `{ estimateInputTokens?, extractOutputTokens? }` | character heuristic (`ceil(chars / 4)`) | Legacy per-function overrides for token counting. Prefer `providerParser`. |
| `providerParser` | `ProviderParser` | built-in registry | Per-host parser that fully overrides model and token extraction. When supplied, the default registry is bypassed. |
| `redaction` | `RedactionConfig` | `DEFAULT_REDACTION_CONFIG` | Which field names are masked, the placeholder string, and which side(s) to mask. See [redaction](#redaction). |
| `requestTransform` | `(requestBody: string) => string \| undefined` | passthrough | Rewrites the outgoing request body. **`http`/`https` path only** — see [Limitations](#limitations). Must be synchronous and must not throw; returning `undefined` or the unchanged input is passthrough. |
| `responseTransform` | `(responseBody: string) => string \| undefined` | passthrough | Reshapes the **logged** response copy — SSE responses only, once per event, before redaction. Never modifies the response your application receives, and is not invoked for buffered responses — see [Limitations](#limitations). Must be synchronous and must not throw. |
| `maxBodyBytes` | `number` | `10 * 1024 * 1024` (10 MiB) | Byte cap on the **capture-side** buffer, applied **independently per direction** (request and response). A value of `0` or negative falls back to the default. |
| `onBodyDropped` | `(info: BodyDroppedInfo) => void` | — | Structured callback fired when `maxBodyBytes` trips. See [body-size cap](#body-size-cap-and-onbodydropped). |

### `capturePayloads`

Defaults to `false`. With the default, `elenwatch` records metadata only (model, token
counts, URL, caller trace) and **never emits request or response body content**. Set it to
`true` to attach `maskedRequestBody` / `maskedResponseBody` to each entry — these are
always passed through [redaction](#redaction) first.

### Body-size cap and `onBodyDropped`

`maxBodyBytes` bounds how many bytes of a body `elenwatch` buffers **for logging**. It
defaults to `10 MiB` (`10 * 1024 * 1024` bytes) and is applied **independently for each
direction** — the request body and the response body each get their own budget.

Once the running byte total for a direction would exceed the cap, no further chunks for
that direction are added to the capture buffer. This has **no effect on the wire**: the
full request is still sent and the full response is still received — only the copy kept
for the log entry is truncated.

When the cap trips, `elenwatch` notifies you in one of two ways:

- If you provided an **`onBodyDropped` callback**, it is called with a `BodyDroppedInfo`
  object. It fires **at most once per `(host, direction)` pair** — the first chunk whose
  append would push the total past the cap.
- If you did **not** provide `onBodyDropped`, `elenwatch` writes a single line to
  `stderr` (via `console.error`) instead. Providing the callback **silences that stderr
  line** — you have taken ownership of the signal.

```ts
interface BodyDroppedInfo {
  host: string;                        // the provider host the body was for
  direction: 'request' | 'response';   // which side tripped the cap
  bytes: number;                       // running total at the trip, clamped to `cap`
  cap: number;                         // the `maxBodyBytes` value in effect
}
```

```ts
new Interceptor({
  capturePayloads: true,
  maxBodyBytes: 512 * 1024, // 512 KiB per direction
  onBodyDropped: (info) => {
    metrics.increment('elenwatch.body_dropped', {
      host: info.host,
      direction: info.direction,
    });
  },
});
```

### Redaction

When `capturePayloads` is `true`, captured bodies are walked and every sensitive field is
replaced with the placeholder (`[REDACTED]` by default) before the body reaches the log
entry. Redaction runs on both the request and response sides by default, is idempotent,
and never mutates the input.

> **Redaction matches field names as case-insensitive _substrings_, not exact names.**
> A field is masked if its (lower-cased) key *contains* any needle. For example the needle
> `address` masks `address`, `homeAddress`, `ip_address`, and `emailAddress` alike; the
> needle `email` masks `userEmail` and `email_verified`. This is deliberately aggressive
> so callers do not have to enumerate every `camelCase` / `snake_case` variant, but it
> **can over-redact** unrelated fields that happen to contain a needle as a substring. The
> built-in needle list cannot currently be narrowed; scope masking to one side with
> `redaction.requestOnly` / `redaction.responseOnly`, or leave `capturePayloads` off.

The built-in needle list (`DEFAULT_SENSITIVE_FIELDS`) covers PII (`email`, `phone`,
`ssn`, name fields), credentials (`password`, `apiKey`, `access_token`, `authorization`,
`cookie`, ...), and financial data (`creditCard`, `cvv`, `iban`, `routing`, ...). Bare
`token` is intentionally **not** a needle — it would substring-match accounting fields
like `completion_tokens` / `total_tokens` — so explicit credential keys are enumerated
instead.

```ts
import { Interceptor } from 'elenwatch';

new Interceptor({
  capturePayloads: true,
  redaction: {
    sensitiveFields: ['internalUserRef'], // masked in ADDITION to the built-in needles
    placeholder: '***',
    responseOnly: true,                   // leave request bodies unmasked
  },
});
```

## Limitations

- **`requestTransform` is `http`/`https`-path only.** It is applied to request bodies
  sent through Node's `http` / `https` modules, but **not** to global `fetch()` request
  bodies. A `fetch()` request body is still *captured* (and redacted, and logged) but is
  **never transformed** — it reaches the server unchanged. This is asymmetric with
  `responseTransform`, and with `requestTransform`'s own behavior on the `http` path.
- **Streamed `fetch()` request bodies are a true pass-through.** When a `fetch()` request
  body is an async iterable / `ReadableStream`, `elenwatch` wraps it in a pull-through
  observer: the request streams to the server at wire speed with exact backpressure — it
  is **not** buffered whole — while a copy of each chunk (up to `maxBodyBytes`) is kept
  for the log entry. The wire always gets the caller's bytes untouched, byte-for-byte,
  even when the body exceeds `maxBodyBytes` — the cap only truncates the logged copy.
- **`requestTransform` buffers the request body until `end()`.** Because the transform
  runs once over the *full* body, configuring it switches the `http`/`https` path to
  buffer-and-hold: body chunks are withheld in memory and written to the socket in a
  single terminal write, with `Content-Length` (when the caller set one) updated to match
  the transformed bytes. Multi-`write()` requests are handled correctly. If headers were
  already flushed before the first body byte (an explicit `flushHeaders()` call), the
  transform is skipped for that request and the body passes through untouched — a flushed
  `Content-Length` can no longer be corrected.
- **One interceptor per process.** `install()` patches `http.ClientRequest.prototype` and
  replaces the global `undici` dispatcher — both process-wide. Only one `Interceptor` can
  be active at a time; construct one, install it once, and call `restore()` to undo the
  patches (it is idempotent). Installing a second interceptor while one is active is not
  supported.
- **`responseTransform` affects the logged copy only, and only on the SSE path.** It is
  invoked once per SSE event before redaction and shapes what lands in
  `maskedResponseBody`; it is **not** invoked for buffered (non-SSE) responses, and it
  never modifies the response your application receives.

## API

`elenwatch` has **named exports only** — there is no default export, and there are no
free-standing `install()` / `restore()` functions. Start and stop interception through an
`Interceptor` instance.

### `class Interceptor`

```ts
import { Interceptor } from 'elenwatch';

const interceptor = new Interceptor(options?: InterceptorOptions);

interceptor.install();  // patch http.ClientRequest.prototype + the global undici dispatcher
interceptor.restore();  // remove the patches; safe to call multiple times (idempotent)
```

`options` is the [`InterceptorOptions`](#configuration) object described above; every
field is optional.

### Loggers

| Export | Kind | Description |
| --- | --- | --- |
| `Logger` | type | `(entry: LlmLogEntry) => void` — the shape every logger (and the `logger` option) must match. |
| `consoleLogger` | value | Writes `JSON.stringify(entry)` to `console.log`. The default `logger`. |
| `noopLogger` | value | Discards every entry. Useful for tests or when only `onBodyDropped` matters. |
| `otelSpanLogger` | value | Turns each entry into an OpenTelemetry span. Requires the optional `@opentelemetry/api` peer; inert without it. |

```ts
import { Interceptor, otelSpanLogger } from 'elenwatch';

const interceptor = new Interceptor({ logger: otelSpanLogger });
interceptor.install();
```

### Types

Exported type-only symbols: `InterceptorOptions`, `LlmLogEntry`, `TokenCounter`,
`RequestTransformer`, `ResponseTransformer`, `Logger`, `ProviderParser`, `ParseResult`,
`RedactionConfig`.

`LlmLogEntry` (the object passed to your `logger`):

```ts
interface LlmLogEntry {
  timestamp: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  callerTrace: string;
  url: string;
  maskedRequestBody?: unknown;   // only when capturePayloads is true and the body was redactable
  maskedResponseBody?: unknown;  // only when capturePayloads is true and the body was redactable
  error?: { message: string; name?: string; stack?: string }; // only on the error path
}
```

### Parsers

| Export | Kind | Description |
| --- | --- | --- |
| `defaultParser` | value | The built-in provider parser (model + token extraction registry). |
| `defaultEstimateInputTokens` | value | Character-heuristic input-token estimate. |
| `defaultExtractOutputTokens` | value | Default output-token extraction. |
| `ProviderParser`, `ParseResult` | types | The parser contract for the `providerParser` option. |

### Redaction

| Export | Kind | Description |
| --- | --- | --- |
| `redact` | value | `redact(payload, config?)` — walk a parsed payload and mask sensitive fields. |
| `DEFAULT_PLACEHOLDER` | value | `'[REDACTED]'`. |
| `DEFAULT_SENSITIVE_FIELDS` | value | The built-in needle list (case-insensitive substrings). |
| `DEFAULT_REDACTION_CONFIG` | value | The default `RedactionConfig`. |
| `RedactionConfig` | type | `{ sensitiveFields?: readonly string[]; requestOnly?: boolean; responseOnly?: boolean; placeholder?: string }`. |

### Other helpers

| Export | Kind | Description |
| --- | --- | --- |
| `deriveUrl` | value | Build the request URL from intercepted request options. |
| `captureCallerTrace` | value | Capture the in-process call site for an entry. |
| `shouldCapture` | value | Whether a given host matches the configured `providers`. |
| `VERSION` | value | The package version string (e.g. `'0.2.1'`). |

### Full example

```ts
import { Interceptor, type LlmLogEntry } from 'elenwatch';

const entries: LlmLogEntry[] = [];

const interceptor = new Interceptor({
  providers: ['api.openai.com', 'api.anthropic.com'],
  capturePayloads: true,
  maxBodyBytes: 1 * 1024 * 1024, // 1 MiB per direction
  logger: (entry) => entries.push(entry),
  onBodyDropped: (info) => {
    console.warn(`elenwatch: dropped ${info.direction} body for ${info.host} at ${info.bytes}/${info.cap} bytes`);
  },
});

interceptor.install();

try {
  await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-...' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
} finally {
  interceptor.restore();
}

console.log(entries[0]?.model, entries[0]?.inputTokens);
```
