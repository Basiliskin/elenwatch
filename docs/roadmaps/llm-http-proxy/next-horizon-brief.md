# Next-horizon brief (for horizon 6) — prepared Stage 3.5, horizon 5


## Unknowns
- Did the committed benchmark-results.md record a budget miss (p50 >=1ms or p99 >=2%) on the request path, the buffered response-data path, or the streaming per-event path — and for any miss, is it attributable to the interceptor/parser code or to environmental noise?
- Did the OTEL-posture decision record name an activation mechanism (optionalDependencies vs peerDependencies vs runtime feature-detect) specific enough that the demo can be written against it without reopening the decision?
- Does the current Logger seam expose enough surface for a span exporter to attach to, or does writing the OTEL demo first require a new seam signature/option beyond what exists?
- Does `npm publish --dry-run` today actually pass cleanly given package.json files[] references a nonexistent package README.md and the author field is empty, or must hygiene fixes land before the publish bar can be claimed?
- Did the package-identity decision resolve the streaming-same-version-additive vs 0.3.0-bump sub-question, and what does that resolution opt into for the still-open blockers.md LlmLogEntry/LlmLoggingOptions semver-freeze question?
- Which of the named streaming residuals (cross-event redaction continuity, caller-visible stream replay, non-SSE streaming formats) are still authentically un-scoped after the transformer-slice re-pin and SSE rewire, rather than implicitly settled?

## Research (before planning horizon 6)
- Read docs/roadmaps/llm-http-proxy/benchmark-results.md for the recorded p50/p99 numbers and the PASS/FAIL verdict per measurement point before deciding whether any latency remediation is owed.
- Re-read decisions.md for the two new records (package identity, OTEL posture) and confirm blockers.md line 2 is actually closed and which deferred bar each record names.
- Read packages/llm-http-proxy/src/logger.ts and its doc comments in src/index.ts:5 and src/logger.test.ts:4 to learn the exact Logger-seam shape an OTEL span exporter must implement.
- Check packages/llm-http-proxy/package.json files[] against the package directory for the missing README.md and empty author field, and run npm publish --dry-run to see what actually blocks a clean publish.
- Run the opt-in `RUN_BENCH=1 npx jest src/benchmark.test.ts` from the package directory to verify the harness still reproduces the committed numbers on current hardware.
- Re-read docs/roadmaps/llm-http-proxy/transformer-slice-spec.md §6 exclusions and the re-pinned per-event clauses to confirm which streaming residuals remain genuinely open.
- Run the two-level gate (package build/lint/typecheck/jest with dist rebuilt, then root build/jest) before planning any phase that will consume or verify the package.

## Decisions needed (horizon 6 cannot avoid these)
- Which deferred full-objective bar to execute first now that both are unblocked — publish verification (dry-run, no deps) vs the OTEL span-exporter demo (dep install + exporter code through the Logger seam) — and whether the two fit in one horizon.
- If the benchmark records a miss: whether latency-regression remediation (interceptor/parser fixes) is next-horizon work or stays unowned follow-up despite the recorded FAIL.
- The OTEL dependency mechanism and version range: optionalDependencies vs peerDependencies for @opentelemetry/*, given the posture record names activation via the Logger seam but no install mechanism is scaffolded yet.
- Whether the missing package README.md and empty author field are must-fix prerequisites for publish verification or acceptable to ship and correct post-publish.
- Whether the streaming residuals (cross-event redaction continuity, caller-visible stream replay, non-SSE formats) get re-scoped into a named future horizon or are permanently declared out.
- Whether the blockers.md semver-freeze question (LlmLogEntry/LlmLoggingOptions frozen vs free to evolve) must be resolved before publish, since publishing locks the public API surface.

## Artifacts to inspect
- docs/roadmaps/llm-http-proxy/benchmark-results.md (recorded p50/p99 numbers + PASS/FAIL verdicts, if the run phase landed)
- docs/roadmaps/llm-http-proxy/decisions.md (the two new records: package identity, OTEL posture)
- docs/roadmaps/llm-http-proxy/blockers.md (line 2 closed; line 4 semver-freeze still open)
- docs/roadmaps/llm-http-proxy/transformer-slice-spec.md (§6 exclusions, re-pinned per-event clauses)
- packages/llm-http-proxy/src/benchmark.test.ts (the RUN_BENCH-gated harness — shape to reproduce numbers on)
- packages/llm-http-proxy/src/logger.ts and src/index.ts (Logger seam — the OTEL exporter activation point)
- packages/llm-http-proxy/src/interceptor.ts (code under latency scrutiny if a miss was recorded)
- packages/llm-http-proxy/package.json (files[]/author publish-hygiene gaps)

## Recommended next-horizon scope
The next horizon should execute one, at most two, of the now-unblocked deferred full-objective bars while keeping the small 3-5 phase envelope — do not attempt both plus residuals. Publish verification is the lighter bar: the name is confirmed free on npm, so it is essentially an `npm publish --dry-run` plus the two known hygiene fixes (the missing package README.md that files[] already references, and the empty author field), with no new feature code and no dependency installs. The OTEL span-exporter demo is the heavier bar — installing optional @opentelemetry/* per the recorded posture, wiring an exporter through the existing Logger seam, and proving opt-in-only activation — and it is the first true consumer of that seam, so it may surface seam gaps that deserve their own horizon rather than sharing one with publish work. Latency-regression remediation is only real work if benchmark-results.md records a miss (p50 >=1ms or p99 >=2%), in which case it should displace one of the bars; the streaming residuals stay declared-out unless the user re-scopes them. Roughly two to four phases.
