# Next-horizon brief (for horizon 10) — prepared Stage 3.5, horizon 9

> Key context: the user has consistently redirected away from the publish-focused Stage 3.5 brief (the original horizon-7 brief). Horizon 8 chose SDK test coverage; horizon 9 chose undici dual-patch. The remaining open work is the end-to-end SDK capture proof (which requires horizon-8's SDK test files to land first), the publish bar (still deferred), and the bench re-run (still deferred).

## Unknowns
- After the undici dual-patch lands (horizon 9), does `globalThis.fetch(...)` actually capture into `entries[]` at runtime against a real localhost mock server, or does the synthetic `ClientRequest`'s view-cast field set miss something `emitLogEntry`/`deriveUrl` needs (e.g., a hostname field that's missing under Node's undici `DispatchOptions` vs an `http.ClientRequest`)?
- When the `undici` peer is absent at runtime, does the lazy-require degrade cleanly — no console warning, no behavioral surprise — and do all horizon-7 tests still pass under that state?
- Is the horizon-5 p99 FAIL (173.88% of baseline) still the open latency item after horizon 9, or does the new undici-patch surface (which runs synchronously inside `dispatch()`) measurably move the bar in either direction?
- Does horizon-8's SDK test surface (when it lands via a future horizon) actually exercise the dual-patch end-to-end with a real `@ai-sdk/*` call, or do the SDK providers fall back to a transport other than global `fetch` (e.g., `node:https.request` internally)?
- Is `undici` 6.x the right pin or should the peer allow both 6.x and 7.x (`^6.0.0 || ^7.0.0`) to anticipate a future major upgrade of Node's bundled undici?

## Research (what the next planner should go look at)
- Re-read `packages/llm-http-proxy/src/interceptor.ts` `WrappingDispatcher` class to verify the synthetic-`ClientRequest` construction wires every field `emitLogEntry`/`deriveUrl`/`resolveScheme` probes via `as unknown as { ... }` view-casts — especially `hostname`/`port`/`path`/`scheme`/`getHeader('host')`.
- Re-read `packages/llm-http-proxy/src/global-fetch-capture.integration.test.ts` to confirm it exercises `globalThis.fetch()` against a localhost mock HTTP server, asserts `entries.length === 1` with the expected `LlmLogEntry` fields, and locks in the round-trip invariant via `expect(getGlobalDispatcher()).toBe(original)` after restore.
- Re-run `npm test` from `packages/llm-http-proxy/` to confirm the new global-fetch test runs by default under ms-scale skip-overhead and that fetch-baseline + the 3 raw-HTTPS tests still pass without modification (the testRegex discovery picks the new file up automatically; no jest config change needed).
- Re-run `npm i -D undici` then `npm test` to confirm the dual-patch engages (different behavior — the new test now hits the undici-patch surface).
- Re-read `docs/roadmaps/llm-http-proxy/decisions.md` to confirm the horizon-9 SDK transport decision entry was appended (option (b) fetch shim) and to check whether the undici-dispatcher decision warrants its own dated entry.
- Re-read `docs/roadmaps/llm-http-proxy/blockers.md` to enumerate which publish-gating blockers are still open vs. now answerable by horizon-8/9's SDK test + dual-patch surfaces.

## Decisions needed
- Whether the next horizon lands horizon-8's deliverables first (SDK devDeps + `sdk-fetch-shim.ts` + 3 `.sdk.integration.test.ts` files with shim wiring) and then verifies the dual-patch works against real SDK-issued `fetch` calls, OR whether the next horizon accepts the global-fetch unit test as sufficient proof of the undici-patch surface and moves to publish-side work.
- Whether the dual-patch's `install()` signature should gain a per-instance option for the undici side (e.g., `patchUndici?: boolean` defaulting true) given that consumers may want to disable it on Node versions where the optional peer is absent without surprises — even though the user's horizon-9 Step-0 explicitly required no new option.
- Whether the undici `setGlobalDispatcher` wrapping should be exposed as a separate top-level utility (so consumers can swap the global dispatcher themselves with `Interceptor`'s wrapping built in), or whether the WrappingDispatcher class stays internal.
- Whether the horizon-5 p99 latency-budget FAIL (173.88% of baseline) gets a clean re-run now that the test surface has stabilized across horizon-8 and horizon-9, or stays closed as a recorded environmental miss.
- Whether the publish-side work (real `npm publish`, semver-freeze from 0.2.0 to 0.3.0, ESM dist inertness proof, prepack/prepare scripts, repository metadata fields, consumer-facing OTEL README docs) should be the next horizon's primary scope — explicitly deferred across horizons 7, 8, and 9 — or stays deferred another horizon in favor of more SDK coverage.

## Artifacts to inspect
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/interceptor.ts` (WrappingDispatcher + dual-patch in install/restore + comment rewrite)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/global-fetch-capture.integration.test.ts` (new test)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/fetch-baseline.integration.test.ts` (must remain unchanged)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/anthropic.integration.test.ts`, `openai.integration.test.ts`, `gemini.integration.test.ts` (must remain unchanged)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/otel.ts` (lazy-require pattern precedent)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/package.json` (new `undici` optional peer dep + `peerDependenciesMeta.undici.optional: true`)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/decisions.md` (any new dated entries added by horizon 9's dual-patch implementation)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/discoveries.md` (the horizon-9 undici-bypass findings: `undici-not-user-importable`, `undici-Dispatcher-types-shape`, `setGlobalDispatcher-round-trip`, `dual-patch-double-emission-mitigation`, `horizon-7-undici-claim-was-wrong`)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/blockers.md` (5 new horizon-9 unknowns)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/state.md` (horizon 9 entry: planned with 1 minor accepted as debt)
- `/Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/benchmark-results.md` (horizon-5 p99 FAIL record)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/node_modules/undici-types/` (the Dispatcher / DispatchOptions / DispatchHandlers type definitions)
- `/Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/.gitignore` (confirm `package-lock.json` still ignored after the optional-peer install)

## Recommended next-horizon scope

The next horizon should land **horizon-8's deferred deliverables** (SDK devDeps + `sdk-fetch-shim.ts` + 3 `.sdk.integration.test.ts` files) and **end-to-end verify the dual-patch against real SDK-issued fetch traffic** — running the live `@ai-sdk/anthropic`/`@ai-sdk/openai`/`@ai-sdk/google` providers WITHOUT the per-file `fetch: createNodeHttpsFetch()` shim option and asserting `entries.length === 1` per provider, since horizon-9's `global-fetch-capture.integration.test.ts` only proves the undici-patch surface against a localhost mock (not against real SDKs). It should also capture the post-horizon-9 baseline (test count via `npx jest --listTests | wc -l`, default-gate wall-clock, lint/typecheck/build all green with the new global-fetch test in place). It should hold off on real `npm publish`, semver-freeze (0.2.0 → 0.3.0), ESM dist inertness proof under a real ESM consumer, prepack/prepare auto-build scripts, repository metadata fields, consumer-facing OTEL README docs, additional provider SDK tests, streaming-mode/auth-error/rate-limit deepening for SDK calls, a jest `testPathIgnorePatterns` migration, a clean re-run of the horizon-5 p99 latency bar, and removing or further restricting the horizon-9 `undici` peer — all of those remain valid candidates for later horizons once the SDK-vs-dual-patch verification lands.
