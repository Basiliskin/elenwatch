# elenwatch — Discoveries

Append-only. One line per grounded fact learned during discovery or
execution. Stated as fact, never as a plan. `[landed]` is marked
mechanically when the fact's horizon is `completed` in state.md;
landed entries are skipped by Step -1's bounded read.

- [landed] 2026-08-31 | horizon 1 | interceptor fetch path | dispatch ignored shouldCapture on the fetch path; http-patch path checked it — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | interceptor race | streamed-request race code lives at interceptor.ts:302-396 — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | synthetic getHeader | `?? hostHeader` returned the host string for any absent header key — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | maxBodyBytes | Logger seam is LlmLogEntry-only; options had no byte cap; capture-state had no byte accounting — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | options surface | InterceptorOptions plumbs through the Interceptor constructor — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | tests | negative (non-provider) fetch test was missing; every existing test used providers:['127.0.0.1'] — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | package.json metadata | lacked repository/bugs/homepage/packageManager — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | VERSION drift | src/index.ts hand-duplicated VERSION; no build step synthesized it — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | sdk-fetch-shim | unexported but compiled to dist and shipped a .d.ts pulling @ai-sdk/anthropic (devDep-only) — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | exports types | exports['.'].types pointed at dist/cjs/index.d.ts for both conditions — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | eslint-disable directives | otel.ts:38 / otel.test.ts:101 dual-rule directives narrowed to the one load-bearing rule — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | test runner | Jest 29.7.0 + ts-jest, NOT Vitest; withEntries pattern at interceptor.test.ts:75-91 — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | Logger seam | Logger type is `(entry: LlmLogEntry) => void`; onBodyDropped is a parallel top-level option — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | undici peer dep | optional peer, absent from node_modules by default; fetch-path tests require('undici') + skip if absent — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | Interceptor.providers | widened private→public readonly so WrappingDispatcher can precheck shouldCapture — see horizon-01 roadmap.md
- [landed] 2026-08-31 | horizon 1 | synthetic getHeader | extracted to exported module-level `syntheticGetHeader` helper with JSDoc; test imports it directly — see horizon-01 roadmap.md
- 2026-08-31 | horizon 1 | APM patch-stacking | README lacks restore() caveat, APM (dd-trace/newrelic) install-order/stacking note — no code fix possible, doc-only
- 2026-08-31 | horizon 1 | no CI | no .github directory exists at repo root
- 2026-08-31 | horizon 1 | no CHANGELOG | no CHANGELOG.md at packages/elenwatch/ or repo root
- 2026-08-31 | horizon 2 | streamed request body | WrappingDispatcher's asyncIterator branch reuses the cap-gated `chunks` array for options.body, so a cap trip truncates the wire body too — see horizon-02 roadmap.md
- 2026-08-31 | horizon 2 | console.error | exactly ONE console.error in interceptor.ts (line 623 in appendChunk, shared by both directions) — one guard on capCtx.onDropped===undefined covers request+response
- 2026-08-31 | horizon 2 | ESM require | bare require('undici')/require('@opentelemetry/api') throw under ESM; the try/catch swallows it so ESM consumers silently lose fetch capture + the OTEL logger [interceptor.ts:87, otel.ts:36]
- 2026-08-31 | horizon 2 | dual build | tsconfig.esm.json moduleResolution bundler emits extensionless dist/esm .js AND .d.ts specifiers that Node ESM + nodenext reject; dist/esm is flat; no prepublishOnly script
- 2026-08-31 | horizon 2 | postbuild verifier | scripts/postbuild.mjs checkTree only regex-checks index.*.js for import/export; every other file unchecked — not a real load test
- 2026-08-31 | horizon 2 | ts-jest | jest block has NO moduleNameMapper (moduleResolution node) — .js in source relative imports would break test resolution; rewrite emitted dist instead
- 2026-08-31 | horizon 2 | requestTransform | only wired on the http write/end path, never in WrappingDispatcher.dispatch — fetch request bodies captured but never transformed; responseTransform has ZERO invocation sites
- 2026-08-31 | horizon 2 | redaction needles | redaction.ts DEFAULT_SENSITIVE_FIELDS ~70 field-name needles matched as case-insensitive SUBSTRINGS; horizon 2 documents this, does not narrow it
- 2026-08-31 | horizon 2 | public API | src/index.ts exports the Interceptor class, Logger type, otelSpanLogger, VERSION — NO free install()/restore(); docs must use new Interceptor(...).install()
- 2026-08-31 | horizon 2 | not a workspace | repo-root package.json + pnpm-lock.yaml are a stale NestJS scaffold; the real package + lockfile are in packages/elenwatch/ — horizon-3 CI runs working-directory: packages/elenwatch
