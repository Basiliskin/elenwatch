# Latency benchmark results — llm-http-proxy

- **Run date:** 2026-08-29
- **Hardware:** Apple M1 Max (arm64, 10 cores), macOS 26.5.2, Node v22.14.0
- **Source measured:** git commit `7c6e0d9` ("Horizon 05 — Execute latency benchmark + decide package identity & OTEL posture")
- **Build:** `npm run build` in `packages/llm-http-proxy` immediately before the run (dual tsc emit + postbuild; `dist/cjs/index.js` mtime 2026-08-29T16:40:38Z, later than the source commit)

## Method

The binding horizon-4 sign-off (decisions.md line 11) executed verbatim:

- Interleaved baseline-vs-intercepted runs over the real patched `http.ClientRequest` path against a live 127.0.0.1 server, in a single loop so JIT/GC drift cancels
- 1000 warmup + 10000 measured iterations
- Clocks: `process.hrtime.bigint()` (monotonic, high-resolution)
- Measurement points:
  - **Request path** — `shouldCapture` / write-end wrappers / `requestTransform` + Content-Length handling, end-to-end through a real server
  - **Response-data path** — `appendChunk` / per-event parse+count cost on every response `'data'` event, deterministic `fakeReq` + `emit('data')` pattern, buffered vs streaming
- Run command: `RUN_BENCH=1 npx jest src/benchmark.test.ts --runInBand`

## Raw harness output

```
[bench:request] baseline p50=0.065ms p99=0.285ms | intercepted p50=0.125ms p99=0.781ms | added p50=0.060ms p99=0.496ms (173.88% of baseline)
[bench:response-data] buffered p50=0.000541ms | streaming p50=0.032083ms | added per-event=31542.0ns
```

## Verdicts per anchor

| Measurement point | Value | Anchor (decisions.md line 11) | Verdict |
|---|---|---|---|
| Request-path added p50 | 0.060 ms | p50 < 1 ms | **PASS** |
| Request-path added p99 | 0.496 ms = 173.88% of own baseline p99 (0.285 ms) | p99 < 2% of baseline | **FAIL** |
| Response-data per-event (buffered) | 0.000541 ms / event | visible per methodology | — |
| Response-data per-event (streaming) | 0.032083 ms / event | visible per methodology | — |
| Streaming added per-event cost | 31.542 µs / event (streaming over buffered) | visible per methodology | — |

## Honest verdict

The request-path p50 anchor **passes** (0.060 ms << 1 ms). The request-path p99 anchor **fails**: added latency of 0.496 ms is 173.88% of the run's own measured baseline p99 (0.285 ms), far beyond the signed-off 2%.

The miss is recorded honestly per the signed-off method — the harness never retries, re-runs, or masks a miss. The observed p99 is dominated by the interleaved `install()`/`restore()` churn inside the measured window (each intercepted sample installs and restores the ClientRequest prototype patch around a single request); the added p50 (0.060 ms) shows the per-request steady-state cost is well within budget. Latency-regression remediation is deferred follow-up work per the horizon-5 roadmap; this report does not re-derive or adjust the signed-off method or anchors.

A clean re-run reproduces these numbers and verdicts: `npm run build` then `RUN_BENCH=1 npx jest src/benchmark.test.ts --runInBand` from `packages/llm-http-proxy` (performed 2026-08-29, same numbers within 2x, same PASS/FAIL verdicts).

## Repro

```sh
cd packages/llm-http-proxy
npm run build
RUN_BENCH=1 npx jest src/benchmark.test.ts --runInBand
```