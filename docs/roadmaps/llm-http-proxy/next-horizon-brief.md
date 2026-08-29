# Next-horizon brief (for horizon 7) — prepared Stage 3.5, horizon 6

## Unknowns
- When the built ESM dist (dist/esm/otel.js) runs in a real ESM consumer without @opentelemetry peers installed, does the try/catch-wrapped lazy require actually stay inert, or does tsc's ESM emit of require() throw (ERR_REQUIRE_ESM/ReferenceError) such that only createRequire(import.meta.url) or an async import would make the ESM build safe? (All horizon-6 proofs run under jest/CJS; the ESM runtime path is untested.)
- Does the vision's full-objective bar — 'an OTEL span exporter that activates only when optional @opentelemetry/* peers are installed' — count as met by the InMemorySpanExporter demo, or does claiming the bar require a wire-level OTLP/HTTP export path to a real collector?
- Given dist/ is gitignored and no prepack/prepublishOnly script exists, is a real `npm publish` intended to run from a pre-built local tree, or must it work from a fresh clone (requiring a prepack/prepare auto-build so it never packs stale or missing dist)?
- Does the recorded request-path p99 FAIL (173.88% of baseline, attributed to interleaved install/restore churn) close the latency full-objective bar as a recorded environmental miss, or is a clean re-run owed before the project's full objective is claimable?
- Do the @opentelemetry/* peerDependency version ranges chosen this horizon actually satisfy a real consumer's `npm install` (peer resolution against the current registry), or was only local devDependency resolution exercised?
- Which of the still-open blockers (semver-freeze of LlmLogEntry/LlmLoggingOptions, process-global monkey-patch acceptability, root workspaces/CI isolation, payload-capture opt-in guarantee, streaming-seam first-class-ness) actually gate a real publish, versus being post-publish product decisions?

## Research (before planning horizon 7)
- Rebuild the package after this horizon and inspect dist/esm/otel.js plus run a genuine ESM smoke test (`node --input-type=module` importing dist/esm/index.js with peers absent then present) to establish whether the ESM lazy-load is truly inert — this decides the deferred ESM item, not a guess from the CJS tests.
- Read packages/llm-http-proxy/src/otel.ts and src/otel.test.ts (created this horizon) for the attribute mapping, the lazy-load mechanism, and whether writing the exporter required a Logger-seam signature change — this resolves blockers.md's open seam-surface question.
- Re-read docs/roadmaps/llm-http-proxy/blockers.md after this horizon to enumerate which open lines (semver-freeze, monkey-patch seam, workspaces/CI, payload-capture guarantee, streaming) still name 'before publish' conditions.
- Re-read packages/llm-http-proxy/README.md (created this horizon) to confirm the mandated content and absence of OTEL docs, and judge whether it is publish-ready as-is.
- Re-check the npm registry (`npm view llm-http-proxy`) at decision time for name availability before planning a real publish — the horizon-5 record says availability is not static.
- Check git status/diff for packages/llm-http-proxy to see whether the newly created package-lock.json was committed or gitignored per the zero-lockfile convention, since any prepack-based real publish depends on that state.
- Re-run `npm publish --dry-run` from the package and compare the tarball contents/warnings against this horizon's baseline to see what (if anything) still blocks a clean real publish.
- Re-read docs/roadmaps/llm-http-proxy/benchmark-results.md and re-run `RUN_BENCH=1 npx jest src/benchmark.test.ts --runInBand` to confirm the p99 FAIL still reproduces before deciding the latency bar's closure.

## Decisions needed (horizon 7 cannot avoid these)
- Whether to execute the last deferred full-objective bar — a real `npm publish` — next, and in what order to resolve the blockers it surfaces (semver-freeze first?) vs continuing to defer publish.
- Whether the public LlmLogEntry/LlmLoggingOptions surface freezes as-is for publish (publishing locks the API), or whether any changes motivated by the OTEL exporter work must land before the freeze.
- Whether to make the lazy peer load actually active in the ESM dist output (createRequire(import.meta.url) / async import) or to accept CJS-only activeness with an inert ESM build as the shipped behavior.
- Whether the full-objective OTEL bar is declared met by the InMemorySpanExporter demo, or whether an OTLP/HTTP/gRPC wire exporter is required to close it.
- Whether spans must join a parent trace (trace propagation / context injection) for the OTEL bar to count, or whether a root-span-per-entry demo is sufficient.
- How much publish-hygiene ceremony is owed before a real publish: prepack/prepublishOnly auto-build, repository/homepage/bugs/publishConfig fields, and consumer-facing OTEL docs in the README — each individually in or out.

## Artifacts to inspect
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/otel.ts
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/otel.test.ts
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/README.md
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/package.json
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/dist/esm/otel.js
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/logger.ts
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/options.ts
- /Users/dimitrykatz/workspace/elenwatch/packages/llm-http-proxy/src/index.ts
- /Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/blockers.md
- /Users/dimitrykatz/workspace/elenwatch/docs/roadmaps/llm-http-proxy/benchmark-results.md

## Recommended next-horizon scope
The next horizon should target the one remaining unexecuted full-objective bar — a real `npm publish` — since the publish-hygiene debt (missing README + empty author) is fixed this horizon and only the semver-freeze decision and the unproven ESM story still stand between the package and publish; it should spend its early phases verifying the built ESM dist's lazy-load inertness (adding createRequire(import.meta.url)/async import only if the smoke test proves the current output unsafe) and resolving the semver-freeze, then close the OTEL bar's completion criterion (InMemory proof vs wire exporter) rather than building new exporter features. It should hold off on OTLP/HTTP wire export, trace propagation/context injection, prepack and repository/metadata ceremony, and consumer-facing OTEL README docs until the decisionsNeeded above are resolved — roughly 3-5 phases, one publish bar plus verification, no new feature code.
