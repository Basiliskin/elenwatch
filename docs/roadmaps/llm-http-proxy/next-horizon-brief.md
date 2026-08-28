# Next-horizon brief (for horizon 3) — prepared Stage 3.5, horizon 2

Horizon 2 (review fixes, correctness findings #1–#7) is planned but **not yet executed** — confirm it
has landed and both gate levels are green before planning horizon 3 on top of it. Horizon 3's natural
content is the three deferred code-review findings: **#8** (negative capture-decision cache), **#9**
(collapse the fake per-provider parser registry), **#10** (remove dead scaffolding from
`src/app.module.ts`). The older vision-track deferrals (latency benchmark, transformer pipeline, OTEL
exporter, package identity/publish, Nest adapter) remain binding `vision.md` success bars but are a
separate, larger slice — keep them for horizon 4+ unless a scope decision promotes them.

## Unknowns
- Has horizon 2 actually been executed and merged, with `packages/llm-http-proxy` gates **and** repo-root `nest build` + root `jest` green?
- Is `#9`'s registry collapse an acceptable clean break on the unpublished 0.1.0 package (single in-repo consumer), or are thin deprecated shims required?
- What does `src/app.module.ts`'s `customProviderParser` actually need once the registry is gone — `defaultParser.extractModel(...)`, the `defaultEstimateInputTokens`/`defaultExtractOutputTokens` helpers directly, or drop the delegate-then-override pattern?
- Is `#8` worth shipping at all before a latency benchmark exists to justify and measure it?
- Should `#9` + `#10` be one coupled phase (they share the `src/app.module.ts` edit and the mandatory package-rebuild-before-root-build step, and `#10` depends on `#9`) or two tightly-ordered phases?

## Research (before planning horizon 3)
- `git status` + run the two-level gate to establish the real green baseline after horizon 2.
- Read `packages/llm-http-proxy/src/provider-parser.ts` and `index.ts` in full: enumerate exactly which symbols `#9` deletes (`parserToTokenCounter` — dead; the 5 parser aliases; `PARSERS_BY_HOST`; `resolveParser` subdomain matching) vs. keeps (`defaultParser`, the `providerParser` option, `ProviderParser`/`ParseResult` types, `defaultEstimateInputTokens`, `defaultExtractOutputTokens`, `parseCall`).
- Read `packages/llm-http-proxy/src/interceptor.ts` `writeWrapper`/`endWrapper`/`onWrapper` + the `kWriteWrapper`/`kEndWrapper`/`kCapture` symbol-tag infra to pin where a `kNoCapture` tag is set and short-circuited for `#8` (three call sites — `onWrapper` is the easily-missed one).
- Read `src/app.module.ts` lines ~1–45 (real wiring: `customProviderParser`, `captureLogger`, `interceptorOptions`, `install()`, `onApplicationShutdown`) and ~68–95 (dead `sample*`/`void`) to size the `#10` edit and design the `OnApplicationBootstrap`/`onModuleInit` hook pairing with the existing `restore()`.
- `grep` the whole repo for imports of `resolveParser` / `parseCall` / the parser aliases — confirm `src/app.module.ts` is the only external consumer before treating `#9` as a contained break.
- Read `provider-parser.test.ts` (342 lines): the `distinct parser per host` and `subdomain resolves` tests assert sameness/defined-ness, not real divergence, and must be rewritten or deleted; every other `resolveParser(host)` handle needs updating.

## Decisions needed (horizon 3 cannot avoid these)
- `#9` public-API posture: clean break (drop `resolveParser`/`parseCall` registry-style exports, update `index.ts` + `interceptor.ts` + `app.module.ts` in lockstep, version bump) vs. thin deprecated shims.
- Whether `#8` is in scope for horizon 3 or dropped/deferred as YAGNI until a latency benchmark exists.
- Phase structure for `#9` + `#10`: one coupled phase vs. two strictly-ordered phases (`#10` after `#9`).
- Horizon-3 scope boundary: pure `#8`/`#9`/`#10` cleanup (recommended, small) vs. also resuming the vision-track work — the latter makes the pre-existing package-identity / latency-methodology / semver-freeze / monkey-patch-strategy blockers binding and dominant.
- Whether the package's built `dist` is committed or CI-rebuilt (root `nest build` reads it via `link:`).

## Artifacts to inspect
- `docs/roadmaps/llm-http-proxy/horizons/horizon-02-review-fixes-roadmap.json` + `.status.json` (once executed)
- `packages/llm-http-proxy/src/provider-parser.ts`, `index.ts`, `provider-parser.test.ts`
- `packages/llm-http-proxy/src/interceptor.ts` (`writeWrapper`/`endWrapper`/`onWrapper` + symbol-tag infra; `emitLogEntry` parser call site)
- `src/app.module.ts`
- `packages/llm-http-proxy/package.json` + its three tsconfigs + `eslint.config.mjs` + inlined Jest config (two-level gate design)
- `docs/roadmaps/llm-http-proxy/{vision.md, decisions.md, blockers.md}` (still-binding vision success bars + prior decisions)

## Recommended next-horizon scope
Treat horizon 3 as a small, self-contained cleanup horizon of **roughly two to three phases** sitting
on top of the shipped horizon-2 review fixes (confirm those are landed and green first). Take `#9`
(collapse the fake per-provider parser registry to one `defaultParser`, drop dead
`parserToTokenCounter`, keep the `providerParser` option as the extension point) and `#10` (remove the
dead `src/app.module.ts` scaffolding, move `install()` into a bootstrap hook) as one coupled unit or
two tightly-ordered phases: they share the `src/app.module.ts` edit, `#10` depends on `#9`, the public
export surface in `index.ts` changes deliberately (a breaking bump is acceptable on the unpublished
0.1.0 with its single in-repo consumer), and every gate must rebuild `packages/llm-http-proxy`'s
`dist` before the repo-root `nest build` sees it. `#8` (the negative capture-decision cache) is
independent and low-value — scope it in only if a decision confirms the sole performance finding is
worth shipping ahead of the latency benchmark; if kept it is a contained `interceptor.ts` change
adding a `kNoCapture` symbol tag at three wrapper call sites (including the easily-missed `onWrapper`),
safe because the request hostname is fixed after construction. Do **not** fold in the vision-track
deferrals (transformer pipeline, latency-budget benchmark, OTEL span exporter) unless a scope decision
explicitly promotes them, in which case the package-identity / semver-freeze / monkey-patch-strategy
decisions in `blockers.md` must be resolved first and will dominate the horizon.
