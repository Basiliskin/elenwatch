# Next-horizon brief (for horizon 4) — prepared Stage 3.5, horizon 3

## Unknowns
- When the response strand buffers a captured response and the caller also has listeners, is the caller supposed to receive the transformed body on the IncomingMessage stream (requiring the interceptor to own/replay the data flow, displacing listeners attached before its own) or does the transform apply only to the buffered copy that emitLogEntry parses?
- After the request strand mutates wire args and the response strand substitutes before JSON.parse, do parseCall/model/token extraction and maskedRequestBody/maskedResponseBody run against the pre- or post-transform body on each strand — is the logged entry the transformed body the caller/wire actually saw, or the originally captured buffer?
- The transformer slice now does work on the request path and adds response-side buffering, contradicting vision.md's "no work beyond body capture on the request path" latency bar — what concrete method and numbers does the not-yet-signed-off benchmark methodology use to budget that work?
- Which of the still-binding vision success bars (latency-budget benchmark, OTEL exporter demo, package identity/publish) were resolved during horizon 3, and which remain blockers the next horizon must unblock first?

## Research (before planning horizon 4)
- Verify horizon 3 actually landed: read the horizon-03 status file + updated state.md line, then re-run the two-level gate (package tsc/eslint/jest/build, root nest build+jest, package dist rebuilt first).
- Read the transformer slice-spec ADR this horizon produced under docs/roadmaps/llm-http-proxy/ and take its committed signatures, InterceptorOptions field names, ordering, Content-Length policy, response buffering boundary and out-of-scope list as contract — do not re-derive them.
- Read interceptor.ts attachCapture (response data/end pipeline) and emitLogEntry to pin where the transformed response body substitutes before JSON.parse and whether any caller-visible re-emission path exists (it is listener-only today).
- Read the landed request-strand implementation in writeWrapper/endWrapper and the transform fields added to options.ts so the response strand mirrors the same passthrough-default / replace-only / Buffer.byteLength semantics.
- Re-read blockers.md and decisions.md: benchmark-methodology sign-off and package name/version decision were open at planning time — verify they still are.
- Grep the package src for 'transform' and 'Content-Length' to inventory the landed request-strand code.
- Read the response-path test designs in interceptor.test.ts (withEntries/post on-wire, fakeReq + direct attachCapture off-network) to reuse the harness.

## Decisions needed (horizon 4 cannot avoid these)
- Log-entry consistency contract: parseCall/redaction/token extraction on pre- vs post-transform bodies per strand.
- Response delivery mechanism: transformed body on the stream (listener ownership/replay) vs transform only on the buffered copy used for emission.
- Scope ordering: finish the transformer pipeline (deferred response strand) first, or unblock the vision-track decisions the transformer slice made urgent (benchmark methodology, package identity/publish, OTEL peer-dep).
- How the rewritten latency bar accommodates transformer work: revised methodology's method and budget numbers.
- Whether the open package name/version blocker is resolved now that VERSION 0.2.0 exists.

## Artifacts to inspect
- docs/roadmaps/.tmp/llm-http-proxy/stage3-phases.json (kept/deferred phase list)
- packages/llm-http-proxy/src/interceptor.ts (attachCapture, emitLogEntry, writeWrapper/endWrapper)
- packages/llm-http-proxy/src/options.ts (landed transform fields)
- packages/llm-http-proxy/src/provider-parser.ts, index.ts (post-#9 surface)
- packages/llm-http-proxy/src/interceptor.test.ts (response-path harness)
- src/app.module.ts (post-#10 lifecycle)
- docs/roadmaps/llm-http-proxy/{decisions.md, blockers.md, state.md}

## Recommended next-horizon scope
The next horizon should land the single deferred transformer phase — response-transform-buffered (buffer captured non-streaming responses, run responseTransform before the caller and before JSON.parse in emitLogEntry see the data, passthrough default) — as one contained infrastructure phase, since this horizon's slice-spec ADR already pins its signatures, buffering boundary and out-of-scope list and the landed request strand gives it a mirror implementation to copy. At most one further phase should tackle the decision both strands made urgent: the benchmark-methodology sign-off in blockers.md, which must now budget transformer work against vision.md's obsolete "no work beyond body capture on the request path" bar. Hold off on the OTEL exporter demo (blocked on the @opentelemetry/* peer-dep decision) and on publish verification (blocked on the still-open package name/version decision) until those blockers are resolved; do not attempt the full latency-budget benchmark until the methodology is signed off. Roughly one to two phases.
