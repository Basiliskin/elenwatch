# elenwatch — Discoveries

Append-only. One line per grounded fact learned during discovery or
execution. Stated as fact, never as a plan. The "what to do about it"
belongs in a phase of the horizon that discovered it (or the next horizon),
not here. `[landed]` is marked mechanically when the fact is encoded in
the repo; landed entries are skipped by Step -1's bounded read.

- 2026-08-31 | horizon 1 | interceptor fetch path | dispatch at interceptor.ts:267 calls attachCapture unconditionally, ignoring shouldCapture; http-patch path checks it [packages/elenwatch/src/interceptor.ts] → fix is one guard + early-return before capture-state allocation
- 2026-08-31 | horizon 1 | interceptor race | actual race code lives at lines 302-396, not the brief's 280-298 [packages/elenwatch/src/interceptor.ts] → cite verified range, not the brief's
- 2026-08-31 | horizon 1 | synthetic getHeader | `?? hostHeader` returns host string for any absent header; only host key is read today so the lie is silent [packages/elenwatch/src/interceptor.ts] → fix returns undefined for absent non-host keys, keep host fallback only for `host`
- 2026-08-31 | horizon 1 | maxBodyBytes | Logger seam is LlmLogEntry-only; options.ts has no maxBodyBytes; capture-state has no byte accounting [packages/elenwatch/src/logger.ts] → parallel onBodyDropped callback separate from Logger; default ~10 MiB
- 2026-08-31 | horizon 1 | options surface | InterceptorOptions lacks maxBodyBytes/onBodyDropped fields and docstring entry [packages/elenwatch/src/options.ts] → add both, plumb through Interceptor constructor at line 683-692
- 2026-08-31 | horizon 1 | negative fetch test missing | interceptor.test.ts has no negative test for non-provider fetch; every existing test sets `providers: ['127.0.0.1']` [packages/elenwatch/src/interceptor.test.ts] → add in interceptor.test.ts (unit-level) with `providers: [/api\.openai\.com/]`
- 2026-08-31 | horizon 1 | APM patch-stacking | README.md (33 lines) lacks restore() caveat, APM stacking note, dd-trace/newrelic mention [packages/elenwatch/README.md] → deferred to next horizon (Phase 5 in deferred list); no code fix possible
- 2026-08-31 | horizon 1 | package.json metadata | package.json lacks repository/bugs/homepage/packageManager fields [packages/elenwatch/package.json] → add all four with git remote + pnpm pin
- 2026-08-31 | horizon 1 | VERSION drift | src/index.ts:33 hand-duplicates VERSION; no build step synthesizes it [packages/elenwatch/src/index.ts] → prebuild script reads package.json and writes src/version.ts
- 2026-08-31 | horizon 1 | sdk-fetch-shim | unexported but compiles to dist and ships .d.ts pulling @ai-sdk/anthropic (devDep-only) [packages/elenwatch/src/sdk-fetch-shim.ts] → exclude from tsconfig.{cjs,esm}.json so it stops emitting
- 2026-08-31 | horizon 1 | exports types | `exports['.'].types` points at dist/cjs/index.d.ts for both import and require; arethetypeswrong flags this [packages/elenwatch/package.json] → split per ESM/CJS, verify with arethetypeswrong
- 2026-08-31 | horizon 1 | eslint-disable directives | otel.ts:38 and otel.test.ts:101 each have a dual-rule directive under tseslint.configs.recommendedTypeChecked [packages/elenwatch/eslint.config.mjs] → verify by removing one at a time and re-running lint; keep if lint fails
- 2026-08-31 | horizon 1 | no CI | no .github directory exists at repo root [packages/elenwatch/.git] → deferred to next horizon; will wire GitHub Actions against the new packageManager pin
- 2026-08-31 | horizon 1 | no CHANGELOG | no CHANGELOG.md at packages/elenwatch/ or repo root [packages/elenwatch/] → deferred to next horizon; Keep-a-Changelog format
- 2026-08-31 | horizon 1 | test runner | Jest 29.7.0 + ts-jest, NOT Vitest (brief assumed Vitest) [packages/elenwatch/package.json] → use jest.fn()/describe/test; withEntries pattern at interceptor.test.ts:75-91 unchanged
- 2026-08-31 | horizon 1 | Logger seam extension | Logger type is `(entry: LlmLogEntry) => void` only [packages/elenwatch/src/logger.ts] → keep Logger unchanged; add onBodyDropped as a parallel top-level option
- 2026-08-31 | horizon 1 | README restore() | README shows install()/restore() in 2 lines; no caveats [packages/elenwatch/README.md] → deferred to next horizon (Limitations section)
