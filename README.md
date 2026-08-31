# elenwatch

A NestJS 11 host application plus a locally-linked npm package,
[`elenwatch`](./packages/elenwatch/), that demonstrates how to wire the
package into a Nest app lifecycle.

The host application in `src/` is intentionally minimal — a single `GET /`
endpoint returning `Hello World!` — and its only job is to install the
`elenwatch` interceptor on `OnApplicationBootstrap` and restore it on
`OnApplicationShutdown`. The package itself is the product.

## Layout

```
elenwatch/
├── src/                              # NestJS host application
│   ├── main.ts                       # bootstrap (PORT ?? 3000)
│   ├── app.module.ts                 # installs / restores the interceptor
│   ├── app.controller.ts             # GET / -> "Hello World!"
│   ├── app.service.ts
│   └── *.spec.ts                     # Jest unit specs
├── test/                             # Jest e2e specs
└── packages/
    └── elenwatch/                    # the npm package (MIT, v0.2.0)
        ├── README.md                 # package-level docs
        ├── package.json
        ├── LICENSE
        └── src/                      # Interceptor, options, parser, redaction,
                                      # OTEL adapter, transformers, event-stream parser
```

## elenwatch (the package)

`elenwatch` intercepts in-process HTTP/HTTPS traffic to LLM provider hosts
(OpenAI, Anthropic, Cohere, Mistral, plus caller-supplied hostnames or regexes)
and emits a typed log entry per call.

- License: MIT — `packages/elenwatch/LICENSE`
- Version: 0.2.0 — dual-published (CJS + ESM), Node `>=18`
- Public surface and usage example:
  [`packages/elenwatch/README.md`](./packages/elenwatch/README.md)
- Optional peer dependencies: `undici`, `@opentelemetry/api`,
  `@opentelemetry/sdk-trace-base`

What it gives you:

- A `Logger` seam — any `(entry: LlmLogEntry) => void` function, plus an
  opt-in `otelSpanLogger` that activates only when the `@opentelemetry/*`
  peers are installed.
- A `ProviderParser` seam — plug your own model/token extraction, or use the
  bundled `defaultParser` which covers OpenAI / Anthropic / Cohere / Mistral
  through one shape.
- Synchronous `requestTransform` and `responseTransform` hooks; the response
  hook runs once over the buffered body or once per SSE event.
- A default payload-redaction pass (`redact()`) over a conservative
  PII / credential / financial field-name list; by default no body content is
  ever emitted.

## Install and run

```bash
pnpm install
pnpm run start:dev       # Nest in watch mode
pnpm run start           # one-shot
pnpm run start:prod      # node dist/main
```

## Test

```bash
pnpm run test            # Jest unit tests (root)
pnpm run test:e2e        # Jest e2e (test/)
pnpm run test:cov        # with coverage
```

The inner package carries its own test suite (unit, provider integration,
SDK integration, OTEL peers-present/absent, opt-in latency benchmark). See
[`packages/elenwatch/`](./packages/elenwatch/).

### Test with env vars

Most provider integration / SDK integration tests inside `packages/elenwatch/`
gate on an API-key env var: when the key is unset (or empty), the suite
resolves to `describe.skip`, so the default `pnpm test` run is credential-free
and never reaches the network. To exercise the live paths, set the relevant
vars before invoking Jest.

Env vars consumed by the test suite:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | gates `openai.integration.test.ts`, `openai.sdk.integration.test.ts` |
| `OPENAI_BASE_URL` | optional override for the OpenAI base URL in those suites |
| `OPENAI_MODEL` | optional override for the model name in those suites |
| `ANTHROPIC_API_KEY` | gates `anthropic.integration.test.ts`, `anthropic.sdk.integration.test.ts` |
| `ANTHROPIC_BASE_URL` | optional override for the Anthropic base URL |
| `ANTHROPIC_MODEL` | optional override for the model name |
| `GEMINI_API_KEY` | gates `gemini.integration.test.ts`, `gemini.sdk.integration.test.ts` (fallback to `GOOGLE_API_KEY`) |
| `GOOGLE_API_KEY` | fallback for the Gemini suites |
| `GEMINI_BASE_URL` | optional override for the Gemini base URL |
| `GEMINI_MODEL` | optional override for the model name |
| `NODE_TLS_REJECT_UNAUTHORIZED` | set to `0` inside `fetch-baseline.integration.test.ts` to talk to the local self-signed fixture server |
| `RUN_BENCH=1` | opt-in switch that enables `benchmark.test.ts` (off by default; the suite runs 1000 warmup + 10000 measured iterations via `hrtime`) |

A template lives at [`packages/elenwatch/.env`](./packages/elenwatch/.env)
with all of the credential / model slots declared (empty). Two ways to feed it
into Jest:

```bash
# Inline — one provider at a time, no extra tooling
OPENAI_API_KEY=sk-... pnpm --filter elenwatch test
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter elenwatch test
GEMINI_API_KEY=... pnpm --filter elenwatch test

# Or load the .env file at invocation time (no project changes required)
# e.g. with dotenv-cli, or any equivalent tool:
dotenv -e packages/elenwatch/.env -- pnpm --filter elenwatch test
```

To run the opt-in latency benchmark:

```bash
RUN_BENCH=1 pnpm --filter elenwatch test -- benchmark.test.ts
```

Notes:

- Never commit a populated `.env`. The repo's `.gitignore` covers it.
- Provider integration tests require outbound network access to the
  configured base URL; the fetch-baseline test uses a local server and is
  self-contained.
- Empty-string env vars are treated as unset by the test suites.

## Build

```bash
pnpm run build           # tsc -> dist/
pnpm run lint            # eslint --fix
pnpm run format          # prettier --write
```

## Tech stack

- TypeScript, NestJS 11, Express (`@nestjs/platform-express`)
- Jest + ts-jest, ESLint 9 + typescript-eslint, Prettier 3
- pnpm

## Status

This repository is a personal learning/portfolio piece. The root `elenwatch`
package is `private: true` with `license: UNLICENSED`; the inner
`elenwatch` package is MIT-licensed and versioned at 0.2.0. There is no
public deployment at this time.

## Source of truth

`docs/marketing/00-product-facts.md` is the single source of truth for any
promotional material written about this project. No README, post, or pitch may
claim more than that document supports.
