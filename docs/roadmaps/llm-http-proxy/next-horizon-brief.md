# Next-horizon brief (for horizon 11) — prepared Stage 3.5, horizon 10

> Key context: horizon 10 closed the SDK-integration-verification gap (the undici dual-patch from horizon 9 now has three SDK integration tests proving `entries.length === 1` per provider with no per-file shim). The remaining publish-side work (real `npm publish`, semver-freeze, ESM dist proof, prepack scripts, repository metadata, OTEL README docs) is consistently deferred across horizons 7, 8, 9, and 10 — the user has redirected away from it each time. The remaining non-publish deferrals (clean re-run of horizon-5 p99 latency bar, additional provider SDK tests, jest `testPathIgnorePatterns` migration, removing or restricting the horizon-9 `undici` peer) are smaller work items that could roll into a smaller post-SDK horizon.

## Unknowns
- With the horizon-10 SDK tests landed, does the post-horizon-10 default `npm test` wall-clock stay within ms-scale skip-overhead of horizon-9's recorded 127 passed / 5 skipped baseline (or 128 / 5 with `undici` present)? Or do three new `*.sdk.integration.test.ts` describe.skip suites push the wall-clock beyond ms-scale — i.e. the deferred gate-metric-from-horizon-5-style wall-clock invariant becomes unenforceable as the test set grows?
- When real `npm publish` runs (whenever that horizon lands), does the published tarball still ship with `dependencies: {}`, `peerDependencies` containing only `@opentelemetry/api` + `@opentelemetry/sdk-trace-base` (optional) + `undici` (optional)? Or does some downstream tooling force a `dependencies` entry that breaks the zero-hard-deps public surface invariant?
- Does `npm install llm-http-proxy` (the real published package, not the in-repo link) work cleanly on a fresh clone with `@opentelemetry/api` and `undici` both absent, both present, and mixed?
- Does the dual-patch's install() still call `setGlobalDispatcher` when `@opentelemetry/api` is present but `undici` is absent? Or does the `undici` optional-peer posture regress and the dual-patch silently degrades to `http.ClientRequest.prototype` only — losing SDK traffic capture on a downstream consumer that happens to install only `@opentelemetry/api`?
- With horizon-10's SDK tests in place, does the post-horizon-10 SDK integration test surface actually exercise SDK streaming calls (`streamText` instead of `generateText`), or does horizon-10 only cover the single-generation happy path? If only the happy path, the deferred streaming-mode deepening is unblocked for whichever horizon wants it.

## Research (what the next planner should go look at)
- Re-read `packages/llm-http-proxy/src/sdk-fetch-shim.ts` to verify the test-only contract is intact — the shim is shipped per horizon-10 user mandate but with zero current consumers; check whether a horizon-11 horizon wants to actually consume it (e.g. as an escape hatch documented in a README) or leave it unused.
- Re-read `packages/llm-http-proxy/src/interceptor.ts` `WrappingDispatcher` to verify the horizon-9 dual-patch surface is the same one horizon-10 SDK tests prove end-to-end.
- Re-read `packages/llm-http-proxy/package.json` to verify post-horizon-10 state: `devDependencies` lists `ai + @ai-sdk/{anthropic,openai,google}`, `dependencies` still `{}`, `peerDependencies` includes the `@opentelemetry/*` optional peers + `undici ^6.0.0 || ^7.0.0` optional peer, `scripts.test` still opt-in for the `RUN_BENCH` benchmark.
- Re-read `docs/roadmaps/llm-http-proxy/decisions.md` to confirm horizon-10's option-B bullet is the last entry and no contradictory entry has been written since.
- Re-read `docs/roadmaps/llm-http-proxy/discoveries.md` for any new entries written during horizon-10 execution (SDK type signature drift, model-name drift, JSDOM/Node lazy-loader surprises, etc.) — a horizon-10 EXECUTE run may surface new grounded facts.
- Re-read `docs/roadmaps/llm-http-proxy/blockers.md` to enumerate which publish-gating blockers remain open vs. now answerable after horizon-10's SDK verification lands.
- Read `packages/llm-http-proxy/package-lock.json` if it exists (horizon-9 noted both `pnpm-lock.yaml` and `package-lock.json` exist on disk; the package-lock.json is gitignored at package level but may still be useful to read for direct debugging).
- Read `packages/llm-http-proxy/.gitignore` line 5 to confirm `package-lock.json` is still ignored post-horizon-10 install.
- Check `registry.npmjs.org/llm-http-proxy` at planning time (the decision-time check on 2026-08-29 returned 404; may have changed by the time horizon-11 plans).

## Decisions needed
- Whether horizon-11 lands the publish-side work (real `npm publish` + semver-freeze `0.2.0 → 0.3.0` + ESM dist lazy-require inertness proof under a real ESM consumer + prepack/prepare auto-build scripts + repository metadata fields + consumer-facing OTEL README docs) — explicitly deferred across horizons 7, 8, 9, and 10; the user's Step-0 redirects have been consistent.
- Whether to widen the SDK coverage to streaming-mode / auth-error-path / rate-limit-backoff / additional providers (Mistral, Cohere, DeepSeek, Bedrock, etc.) before publish — YAGNI gate 1 says not unless asked.
- Whether to clean re-run the horizon-5 p99 latency bar now that horizon-8 (SDK) and horizon-9 (undici) and horizon-10 (SDK end-to-end) have stabilized the test surface, or stay closed as a recorded environmental miss.
- Whether to migrate from `describe.skip` per file to jest `testPathIgnorePatterns` config (rejected in horizon-7 fetch-baseline-contract-shift; revisit only if the skip overhead budget becomes untenable).
- Whether to tighten the horizon-9 `undici` peer range (`^6.0.0 || ^7.0.0` → narrower, e.g. `^6.0.0` only, or remove the peer entirely) — would invalidate horizon-10's verification if done mid-test-set.

## Artifacts to inspect
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/package.json` (post-horizon-10 state: devDependencies + dependencies {} + peerDependencies including undici optional)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/sdk-fetch-shim.ts` (horizon-10 shim, test-only surface with zero current consumers)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/{anthropic,openai,gemini}.sdk.integration.test.ts` (horizon-10's three SDK integration tests)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/interceptor.ts` (horizon-9 dual-patch + horizon-10 SDK-verification-ready install/restore)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/otel.ts` (lazy-require pattern precedent for the optional OTEL peers)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/.gitignore` line 5 (verify `package-lock.json` still gitignored post-horizon-10 install)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/index.ts` (verify public surface unchanged: no SDK re-export, no shim re-export, VERSION still 0.2.0)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/tsconfig.json` (types:['node','jest'], ESM/CJS, strict)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/README.md` (if exists — verify it stays honest about zero-hard-deps and optional peers post-horizon-10)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/decisions.md` (latest entry should be `2026-08-30 | horizon 10 | ...` option-B bullet)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/discoveries.md` (any new horizon-10 EXECUTE discoveries: SDK type drift, model-name drift, etc.)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/blockers.md` (publish-gating blockers status)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/benchmark-results.md` (horizon-5 p99 FAIL record; if horizon-11 plans a clean re-run, this is the comparison anchor)
- `/Users/dimitrykatz/workspace/elenwatch/registry.npmjs.org/llm-http-proxy` (decision-time registry check; should still return 404 if the package is still unpublished)

## Recommended next-horizon scope

The next horizon should land the publish-side work that has been consistently deferred across horizons 7, 8, 9, and 10: real `npm publish` against the registry, semver-freeze `0.2.0 → 0.3.0` (with a CHANGELOG-style entry capturing the dual-patch + SDK integration tests as the breaking-since-0.2.0 surface), ESM dist lazy-require inertness proof under a real ESM consumer (the `undici` and `@opentelemetry/*` lazy-requires must remain inert when the peers are absent), prepack/prepare auto-build scripts so a fresh clone can `npm install && npm publish`, repository/homepage/bugs/publishConfig metadata fields, and consumer-facing OTEL README docs (the dual-patch, the OTEL span exporter, the SDK test escape hatch, and the optional-peer surface). It should hold off on additional provider SDK tests (YAGNI gate 1), streaming-mode deepening for SDK calls (YAGNI / not asked for), a clean re-run of the horizon-5 p99 latency bar (recorded environmental miss, stays closed unless the user requests), jest `testPathIgnorePatterns` migration (rejected in horizon-7), removing or further restricting the horizon-9 `undici` peer (would invalidate horizon-10's SDK verification), and any rework of the horizon-10 SDK fetch shim (the shim's test-only-with-zero-current-consumers posture is a user-mandated deliverable, not a refactoring target).