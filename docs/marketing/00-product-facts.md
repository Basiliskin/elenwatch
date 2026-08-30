# Product Facts

> Single source of truth for all downstream marketing skills. No promotional material may claim more
> than this document supports.

## Verified facts

Every fact traced to a repository file, the README, or the user. The `source:` field is restricted to
`<repo-relative path>` | `README` | `user`.

### Repository layout and tech stack

- The repository is named `elenwatch` and contains a NestJS host application at the root plus a locally-linked npm package at `packages/llm-http-proxy/` — source: `package.json`
- Written in TypeScript — source: `package.json`
- Root application runs on NestJS 11 (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` all at `^11.0.1`) — source: `package.json`
- HTTP platform is Express (`@nestjs/platform-express`) — source: `package.json`
- Tests run on Jest with `ts-jest` — source: `package.json`
- Linting uses ESLint 9 + typescript-eslint; formatting uses Prettier 3 — source: `package.json`
- Package manager is pnpm (lockfile `pnpm-lock.yaml`, scripts use `pnpm run`) — source: `README.md`, `pnpm-lock.yaml`
- Source root is `src/` (per `nest-cli.json`) — source: `nest-cli.json`

### Root package metadata

- Root `package.json` has `name: "elenwatch"`, `version: "0.0.1"`, `private: true`, `license: "UNLICENSED"` — source: `package.json`
- Root depends on a local link `llm-http-proxy: link:packages/llm-http-proxy` — source: `package.json`

### Root application behavior

- Entry point is `src/main.ts`, which calls `NestFactory.create(AppModule)` and listens on `process.env.PORT ?? 3000` — source: `src/main.ts`
- Single controller `AppController` exposes `@Get()` returning `'Hello World!'` via `AppService.getHello()` — source: `src/app.controller.ts`, `src/app.service.ts`
- `AppModule` implements `OnApplicationBootstrap` and `OnApplicationShutdown` — source: `src/app.module.ts`
- On bootstrap, the module calls `llmHttpInterceptor.install()`; on shutdown it calls `restore()` — source: `src/app.module.ts`
- The interceptor instance is exported from `app.module.ts` as `llmHttpInterceptor` — source: `src/app.module.ts`
- `AppModule` exposes three DI tokens: `LLM_HTTP_PROXY_INTERCEPTOR`, `LLM_HTTP_PROXY_RECENT_CALLS` (an in-memory ring buffer with capacity 50), and `LLM_HTTP_PROXY_VERSION` — source: `src/app.module.ts`
- Captured entries are forwarded to `consoleLogger` after being pushed into `RECENT_CALLS` — source: `src/app.module.ts`
- The host app supplies a custom `ProviderParser` that delegates to `defaultParser` and maps any `unknown` model name to `'elenwatch-fallback'` — source: `src/app.module.ts`
- The host app's input-token estimator uses `ceil(chars / 3)` over the stringified request — source: `src/app.module.ts`
- The host app's output-token extractor reads `usage.total_tokens` — source: `src/app.module.ts`
- The host configures provider matching for `api.openai.com`, `api.anthropic.com`, `api.cohere.ai`, `api.mistral.ai`, and a regex `^https?:\/\/.*\.internal\.elenwatch\.test$/` — source: `src/app.module.ts`
- The host opts into payload capture (`capturePayloads: true`) — source: `src/app.module.ts`
- The host extends `DEFAULT_SENSITIVE_FIELDS` with `'elenwatchSecret'` and uses `[REDACTED]` as the redaction placeholder — source: `src/app.module.ts`

### Tests at the root

- Unit test asserts `AppController.getHello()` returns `"Hello World!"` — source: `src/app.controller.spec.ts`
- E2E test (`test/app.e2e-spec.ts`) asserts `GET /` returns 200 with body `Hello World!` — source: `test/app.e2e-spec.ts`
- AppModule lifecycle tests pin the contract that importing `AppModule` does NOT patch `http.ClientRequest.prototype` until `app.init()` runs, and that the patch is released on `app.close()` — source: `src/app.module.spec.ts`
- AppModule tests assert a real outbound HTTP call (host header `api.openai.com`) through the booted app is captured and logged via `consoleLogger` — source: `src/app.module.spec.ts`

### llm-http-proxy package metadata

- Package name `llm-http-proxy`, version `0.2.0`, `license: MIT` — source: `packages/llm-http-proxy/package.json`
- Author listed as `Dimitry Katz <dimitry.kazt@gmail.com>` — source: `packages/llm-http-proxy/package.json`
- Dual-publish: `main` is `./dist/cjs/index.js`, `module` is `./dist/esm/index.js`, `exports` map points both — source: `packages/llm-http-proxy/package.json`
- Engines require Node `>=18` — source: `packages/llm-http-proxy/package.json`
- `sideEffects: false` — source: `packages/llm-http-proxy/package.json`
- `undici` (`^6.0.0 || ^7.0.0`), `@opentelemetry/api` (`^1.9.1`), and `@opentelemetry/sdk-trace-base` (`^2.10.0`) are listed as optional peer dependencies — source: `packages/llm-http-proxy/package.json`
- `keywords` declare `llm`, `http`, `interceptor`, `proxy`, `telemetry`, `openai`, `anthropic`, `cohere`, `mistral` — source: `packages/llm-http-proxy/package.json`
- MIT license file is present at `packages/llm-http-proxy/LICENSE` (copyright 2026) — source: `packages/llm-http-proxy/LICENSE`

### llm-http-proxy public API

- Entry point re-exports `Interceptor`, `deriveUrl`, `captureCallerTrace`, `shouldCapture`, `defaultParser`, `defaultEstimateInputTokens`, `defaultExtractOutputTokens`, `redact`, `DEFAULT_PLACEHOLDER`, `DEFAULT_SENSITIVE_FIELDS`, `DEFAULT_REDACTION_CONFIG`, `consoleLogger`, `noopLogger`, `otelSpanLogger` — source: `packages/llm-http-proxy/src/index.ts`
- Re-exported types: `ProviderParser`, `ParseResult`, `RedactionConfig`, `Logger`, `InterceptorOptions`, `LlmLogEntry`, `TokenCounter`, `RequestTransformer`, `ResponseTransformer` — source: `packages/llm-http-proxy/src/index.ts`
- Exports a string constant `VERSION = '0.2.0'` — source: `packages/llm-http-proxy/src/index.ts`

### llm-http-proxy interception contract

- `LlmLogEntry` carries `timestamp`, `model`, `inputTokens`, `outputTokens`, `callerTrace`, `url`, and optional `maskedRequestBody`, `maskedResponseBody`, `error` — source: `packages/llm-http-proxy/src/options.ts`
- By default the entry carries no body content; masked-payload fields populate only when `capturePayloads: true` — source: `packages/llm-http-proxy/src/options.ts`
- `ProviderParser` is a pure function interface with `extractModel`, `estimateInputTokens`, `extractOutputTokens` — source: `packages/llm-http-proxy/src/provider-parser.ts`
- `defaultParser` extracts model from `model` or `model_name`, falling back to `'unknown'`; estimates input tokens via `ceil(chars / 4)` over messages/prompt/input text; extracts output tokens preferring `usage.completion_tokens` (OpenAI) over `usage.output_tokens` (Anthropic), falling back to `ceil(chars / 4)` over choices/completion/output_text — source: `packages/llm-http-proxy/src/provider-parser.ts`
- `defaultParser` covers OpenAI, Anthropic, Cohere, and Mistral with a single shape — source: `packages/llm-http-proxy/src/provider-parser.ts`
- `requestTransform` runs exactly once between chunk capture and wire forwarding; returning `undefined` is passthrough (Content-Length not rewritten) — source: `packages/llm-http-proxy/src/options.ts`
- `responseTransform` runs once over the full buffered body at `end`, or once per SSE event when the response is `text/event-stream` — source: `packages/llm-http-proxy/src/options.ts`
- Both transformers are synchronous and must not throw; throwing transformers are caught and treated as passthrough — source: `packages/llm-http-proxy/src/options.ts`

### llm-http-proxy redaction

- `redact()` is idempotent and does not mutate its input — source: `packages/llm-http-proxy/src/redaction.ts`
- `DEFAULT_SENSITIVE_FIELDS` covers PII (`email`, `phone`, `ssn`, `dob`, names, addresses), credentials (`password`, `apiKey`, `accessToken`, `refreshToken`, `authToken`, `apiToken`, `idToken`, `authorization`, `credential`, `privateKey`, `sessionId`, `cookie`), and financial data (`creditCard`, `cvv`, `cvc`, `iban`, `accountNumber`, `routingNumber`, `salary`, `income`) — source: `packages/llm-http-proxy/src/redaction.ts`
- Default placeholder string is `[REDACTED]` — source: `packages/llm-http-proxy/src/redaction.ts`
- Substring matching is used (e.g. `userEmail` hits `email`); bare `token` is intentionally excluded to avoid substring-matching `completion_tokens` / `total_tokens` — source: `packages/llm-http-proxy/src/redaction.ts`

### llm-http-proxy OTEL adapter

- `otelSpanLogger` is exported as a `Logger`-compatible function — source: `packages/llm-http-proxy/src/index.ts`
- `@opentelemetry/api` is resolved lazily inside a try/catch; when the peer is absent the adapter is a non-throwing no-op — source: `packages/llm-http-proxy/src/otel.ts`
- When the peer is present the adapter emits a span named `llm-http-proxy.llm-call` on tracer `llm-http-proxy` with start time taken from `entry.timestamp` and attributes copied from the entry's fields — source: `packages/llm-http-proxy/src/otel.ts`
- The span is ended in a `finally` block, including on the error path; the error path also calls `recordException` and sets `SpanStatusCode.ERROR` — source: `packages/llm-http-proxy/src/otel.ts`

### llm-http-proxy tests

- Provider integration tests exist for fetch baseline, OpenAI, Anthropic, and Gemini — source: `packages/llm-http-proxy/src/fetch-baseline.integration.test.ts`, `packages/llm-http-proxy/src/openai.integration.test.ts`, `packages/llm-http-proxy/src/anthropic.integration.test.ts`, `packages/llm-http-proxy/src/gemini.integration.test.ts`
- SDK integration tests exist for OpenAI, Anthropic, and Gemini — source: `packages/llm-http-proxy/src/openai.sdk.integration.test.ts`, `packages/llm-http-proxy/src/anthropic.sdk.integration.test.ts`, `packages/llm-http-proxy/src/gemini.sdk.integration.test.ts`
- Global-fetch-capture integration test proves the dual-patch path; it tees the AsyncIterable body capture inside `dispatch()` and preserves content-length integrity — source: `packages/llm-http-proxy/src/global-fetch-capture.integration.test.ts`, `docs/roadmaps/llm-http-proxy/state.md`
- Benchmark test (`benchmark.test.ts`) is opt-in via `RUN_BENCH`, uses `hrtime`, runs 1000 warmup + 10000 measured iterations, interleaved — source: `packages/llm-http-proxy/src/benchmark.test.ts`, `docs/roadmaps/llm-http-proxy/state.md`
- OTEL tests cover peers-present (InMemorySpanExporter round-trip with full attribute and timestamp fidelity) and peers-absent (inertness via `jest.isolateModules` + `jest.doMock`) — source: `packages/llm-http-proxy/src/otel.test.ts`, `docs/roadmaps/llm-http-proxy/state.md`
- Horizon 5 recorded the benchmark verdict: request p50 PASS 0.060ms; request p99 FAIL 173.88% of baseline; buffered response-data 0.000541ms; streaming response-data 0.032083ms/event — source: `docs/roadmaps/llm-http-proxy/state.md`
- Horizon 6 recorded `npm publish --dry-run` exit 0 with README/LICENSE/dist in the tarball — source: `docs/roadmaps/llm-http-proxy/state.md`
- Horizon 5 confirmed the npm name `llm-http-proxy` was 404 (free) at decision time on 2026-08-29 — source: `docs/roadmaps/llm-http-proxy/state.md`

### llm-http-proxy README

- The package README describes the library as "Near-zero-latency interception of in-process LLM provider HTTP/HTTPS traffic with pluggable loggers, per-provider parsers, request/response transformers, and payload redaction." — source: `packages/llm-http-proxy/README.md`
- The README example shows `new Interceptor({ logger })`, `interceptor.install()`, and `interceptor.restore()` (idempotent) — source: `packages/llm-http-proxy/README.md`
- The README states the logger option accepts any function matching `(entry: LlmLogEntry) => void` so consumers can route entries to their own logging or telemetry pipeline — source: `packages/llm-http-proxy/README.md`

## Repository evidence

Concrete file paths in this repository that back the Verified facts.

- `package.json`
- `pnpm-lock.yaml`
- `nest-cli.json`
- `.gitignore`
- `README.md`
- `src/main.ts`
- `src/app.module.ts`
- `src/app.controller.ts`
- `src/app.service.ts`
- `src/app.controller.spec.ts`
- `src/app.module.spec.ts`
- `test/app.e2e-spec.ts`
- `test/jest-e2e.json`
- `packages/llm-http-proxy/package.json`
- `packages/llm-http-proxy/LICENSE`
- `packages/llm-http-proxy/README.md`
- `packages/llm-http-proxy/src/index.ts`
- `packages/llm-http-proxy/src/interceptor.ts`
- `packages/llm-http-proxy/src/options.ts`
- `packages/llm-http-proxy/src/provider-parser.ts`
- `packages/llm-http-proxy/src/redaction.ts`
- `packages/llm-http-proxy/src/logger.ts`
- `packages/llm-http-proxy/src/otel.ts`
- `packages/llm-http-proxy/src/sdk-fetch-shim.ts`
- `packages/llm-http-proxy/src/event-stream-parser.ts`
- `packages/llm-http-proxy/src/types-undici.d.ts`
- `packages/llm-http-proxy/src/interceptor.test.ts`
- `packages/llm-http-proxy/src/provider-parser.test.ts`
- `packages/llm-http-proxy/src/redaction.test.ts`
- `packages/llm-http-proxy/src/logger.test.ts`
- `packages/llm-http-proxy/src/otel.test.ts`
- `packages/llm-http-proxy/src/benchmark.test.ts`
- `packages/llm-http-proxy/src/event-stream-parser.test.ts`
- `packages/llm-http-proxy/src/fetch-baseline.integration.test.ts`
- `packages/llm-http-proxy/src/openai.integration.test.ts`
- `packages/llm-http-proxy/src/anthropic.integration.test.ts`
- `packages/llm-http-proxy/src/gemini.integration.test.ts`
- `packages/llm-http-proxy/src/openai.sdk.integration.test.ts`
- `packages/llm-http-proxy/src/anthropic.sdk.integration.test.ts`
- `packages/llm-http-proxy/src/gemini.sdk.integration.test.ts`
- `packages/llm-http-proxy/src/global-fetch-capture.integration.test.ts`
- `docs/roadmaps/llm-http-proxy/state.md`
- `docs/roadmaps/llm-http-proxy/vision.md`
- `docs/roadmaps/llm-http-proxy/benchmark-results.md`
- `docs/roadmaps/llm-http-proxy/blockers.md`
- `docs/roadmaps/llm-http-proxy/decisions.md`
- `docs/roadmaps/llm-http-proxy/discoveries.md`
- `docs/roadmaps/llm-http-proxy/next-horizon-brief.md`
- `docs/roadmaps/llm-http-proxy/transformer-slice-spec.md`

## User-provided facts

Only the four non-derivable categories: production URL, primary goal, open-source status, features not visible in the repository.

- Production URL: none yet — source: user
- Primary goal: personal learning/portfolio — source: user
- Open-source status: the inner `llm-http-proxy` package is MIT-licensed; the root `elenwatch` repository is private (`license: UNLICENSED`) — source: user (corroborated by `package.json` and `packages/llm-http-proxy/package.json`)
- Features not visible in the repository: none — source: user

## Unknown

Gaps recorded as open. Never invent an answer here.

- Production URL — no deployment exists; the project has not been published to npm at the time of writing (state.md recorded the npm name as 404 on 2026-08-29)
- Number of active users / downloads / installs
- Real-world production telemetry from consumers of the package
- Production-grade latency characterization beyond the opt-in `RUN_BENCH` benchmark recorded in `state.md` (note: the recorded p99 fails the horizon-5 budget verdict, so latency claims are not safe to make)
- Browser support (not applicable — the package targets Node `>=18`; recorded here to prevent an accidental assumption)
- Community size, contributor count, downstream dependents
- Whether the package has been published to npm since the 2026-08-29 404 record

## Forbidden assumptions

Never claim the following without explicit evidence. Un-evidenced occurrences are parked here, not in Verified facts.

- **fastest** — the package README uses the phrase "near-zero-latency," but the package's own horizon-5 benchmark recorded request p99 at 173.88% of baseline (FAIL). No external benchmarked evidence supports a superlative speed claim.
- **most secure** — no security audit, certification, or formal threat-model report is present in the repository.
- **better than competitors** — no head-to-head benchmark against any named alternative exists in the repository.
- **privacy-preserving** — redaction is a design feature (default `capturePayloads: false` plus a conservative sensitive-field list), but the rules forbid emitting this claim without explicit evidence; the package is observability/telemetry tooling, not a privacy product, and the README makes no such claim.
