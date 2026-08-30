# elenwatch

A NestJS 11 host application plus a locally-linked npm package,
[`llm-http-proxy`](./packages/llm-http-proxy/), that demonstrates how to wire the
package into a Nest app lifecycle.

The host application in `src/` is intentionally minimal — a single `GET /`
endpoint returning `Hello World!` — and its only job is to install the
`llm-http-proxy` interceptor on `OnApplicationBootstrap` and restore it on
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
    └── llm-http-proxy/               # the npm package (MIT, v0.2.0)
        ├── README.md                 # package-level docs
        ├── package.json
        ├── LICENSE
        └── src/                      # Interceptor, options, parser, redaction,
                                      # OTEL adapter, transformers, event-stream parser
```

## llm-http-proxy (the package)

`llm-http-proxy` intercepts in-process HTTP/HTTPS traffic to LLM provider hosts
(OpenAI, Anthropic, Cohere, Mistral, plus caller-supplied hostnames or regexes)
and emits a typed log entry per call.

- License: MIT — `packages/llm-http-proxy/LICENSE`
- Version: 0.2.0 — dual-published (CJS + ESM), Node `>=18`
- Public surface and usage example:
  [`packages/llm-http-proxy/README.md`](./packages/llm-http-proxy/README.md)
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
[`packages/llm-http-proxy/`](./packages/llm-http-proxy/).

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
`llm-http-proxy` package is MIT-licensed and versioned at 0.2.0. There is no
public deployment at this time.

## Source of truth

`docs/marketing/00-product-facts.md` is the single source of truth for any
promotional material written about this project. No README, post, or pitch may
claim more than that document supports.
