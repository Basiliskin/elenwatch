# Next-horizon brief (for horizon 5) — prepared Stage 3.5, horizon 4


## Unknowns
- Do real OpenAI chat/completions and Anthropic Messages streaming responses actually deliver the terminal usage-bearing event (OpenAI final usage chunk, Anthropic message_delta usage) and a per-chunk model field in every default interaction — or only when usage/stream_usage request params are set — so the 'usage-wins-else-incremental-estimate' AC is reachable without those params?
- On a mid-stream abort or connection drop before the terminal SSE event, does the rewired response strand emit any entry at all — attachCapture still has NO res 'error'/'aborted'/'close' handler — and if it emits, does it degrade to 'unknown'/0, violating AC item 1?
- When capturePayloads=true AND responseTransform are both set on the SSE path, which body feeds parseCall and maskedResponseBody — pre- or post-transform, pre- or post-redaction — and does the re-pinned ADR §3 state this unambiguously for the per-event path?
- What is the exact SSE-detection fallback cap/threshold when content-type is absent but data:-line shape is present, and can a non-SSE chunked JSON response be misrouted into the streaming path with silent corruption or unbounded accumulation?
- Do the signed-off latency budget numbers cover the per-event parse+count work now on the response-data path, or only request-path transformer work — can the later benchmark-execution horizon measure without that ambiguity?
- Was the @opentelemetry/* peer-dep decision made by this horizon's close, or does the OTEL span-exporter demo remain blocked?
- Is the horizon-1 package name/version/license blocker still open, and are the streaming additions a same-version additive surface or do they imply a 0.3.0 bump before package-identity-and-publish can proceed?
- How many tests does the package hold at this horizon's close (95 at horizon 3), and did the streaming additions include an end/error/abort-ordering regression set beyond the happy-path stream test?

## Research (before planning horizon 5)
- Read the current horizon's roadmap+status files (horizons/horizon-04-*.json and *.status.json) and state.md to confirm which of the five phases landed, the new package test count, and any open success-coverage debt.
- Re-read the re-pinned docs/roadmaps/llm-http-proxy/transformer-slice-spec.md §§1-6 and take its per-event vs buffered responseTransform semantics, capturePayloads=true policy, and named cross-event redaction residual as binding contract — do not re-derive them.
- Read decisions.md for the signed-off benchmark methodology + budget numbers (the binding input for any latency-benchmark-execution phase) and confirm blockers.md line 3 was actually closed.
- Grep packages/llm-http-proxy/src for responseTransform, text/event-stream, and the event-stream-parser import to verify the detection line, the invocation sites, and that additive surface stayed additive.
- Read the landed event-stream-parser.ts module and its tests to learn the exact StreamingResult shape before planning anything that consumes it.
- Re-read interceptor.test.ts's startServer/post/withEntries real-patched-path and fakeReq+emit('data') harnesses to reuse for a benchmark or abort-order spec.
- Re-run the two-level gate (package tsc/eslint/jest/build, root build+jest with package dist rebuilt first) before planning any code phase.
- Check git log and packages/llm-http-proxy/package.json scripts/testRegex to see whether any bench infrastructure or live fixtures (src/__fixtures__/) actually landed.

## Decisions needed (horizon 5 cannot avoid these)
- Latency-benchmark execution scope: whether to execute the signed-off benchmark in the next horizon, and if so which runner — no *.bench.ts would be picked up by either jest config, so the harness is a standalone script or a jest-compat spec, and the interleaved baseline/interception design must faithfully match the signed-off method without gaming the p50/p99 measurement points.
- Package identity: whether to finally resolve the horizon-1 name/version/license choice now (VERSION 0.2.0 exists with a real in-repo consumer) to unblock package-identity-and-publish, or defer it yet again.
- Streaming as public API: whether to export the event-stream parser / StreamingResult from index.ts as first-class 0.2.0 surface, or keep streaming additive-internal — intertwined with the unresolved blockers.md semver-freeze question.
- OTEL peer-dep posture: whether to make the @opentelemetry/* optional-deps-activation decision now (unblocking the deferred OTEL span-exporter demo) or leave it parked.
- Which deferred full-objective bar to sequence first — benchmark-execution, OTEL-exporter-demo, or publish-verification — and whether the named streaming residuals (cross-event redaction continuity, caller-visible replay, non-SSE formats) are re-scoped in or declared permanently out.

## Artifacts to inspect
- packages/llm-http-proxy/src/event-stream-parser.ts (landed this horizon — StreamingResult shape, bounded line/event buffer)
- packages/llm-http-proxy/src/interceptor.ts (rewired attachCapture 'response' callback, SSE detection, completeCapture/emitLogEntry interplay)
- packages/llm-http-proxy/src/options.ts (InterceptorOptions — whether responseTransform landed additively)
- packages/llm-http-proxy/src/index.ts (public export surface — did streaming types get exported?)
- packages/llm-http-proxy/src/interceptor.test.ts (streaming tests + startServer/post/withEntries and fakeReq harnesses)
- packages/llm-http-proxy/src/__fixtures__/ (only if created — provenance of provider transcripts, live vs doc-lifted)
- docs/roadmaps/llm-http-proxy/transformer-slice-spec.md (re-pinned §§1-6, per-event ordering clause, cross-event redaction residual)
- docs/roadmaps/llm-http-proxy/decisions.md (signed-off benchmark methodology + budget numbers lines, and the vision.md reconciliation)
- docs/roadmaps/llm-http-proxy/blockers.md (line 3 benchmark-methodology closure; still-open status of the others)
- docs/roadmaps/llm-http-proxy/state.md (this horizon's completed/planned entry)
- docs/roadmaps/llm-http-proxy/vision.md (reconciled latency bar + remaining still-binding success bars)
- packages/llm-http-proxy/package.json (scripts + jest testRegex — what a bench harness must conform to)

## Recommended next-horizon scope
The next horizon should be small and decision-driven: first verify this horizon's lands (parser, re-pin, rewire, methodology sign-off) and then execute the now-signed-off latency benchmark — the one deferred item that is unblocked and needs no further decisions — keeping it to one contained phase (harness + run + numbers recorded against the signed-off method, explicitly measuring the streaming response-data-path cost if the methodology requires it). Alongside that, resolve the two pure-decision blockers that gate whole deferred bars and fit without code: package identity (name/version/license) and the OTEL peer-dep posture, decided in decisions.md; that unblocks publish-verification and the OTEL demo for later horizons. Hold off on actually building the OTEL exporter demo and publish verification until those two decisions land, and do not attempt cross-event redaction continuity, caller-visible stream replay, or non-SSE streaming formats unless the user re-scopes them — they are named residuals, not next-horizon work. Roughly one to three phases.
