/**
 * Latency benchmark harness (opt-in).
 *
 * Executes the binding latency-benchmark method signed off in
 * decisions.md (horizon 4): interleaved baseline-vs-intercepted runs over
 * the real patched http.ClientRequest path, 1000 warmup + 10000 measured
 * iterations, monotonic high-resolution clocks (process.hrtime.bigint),
 * measuring both named measurement points:
 *
 *   1. the REQUEST path — shouldCapture / write-end wrappers /
 *      requestTransform / Content-Length handling (measured end-to-end
 *      through a real 127.0.0.1 server),
 *   2. the RESPONSE-DATA path — appendChunk / per-event parse+count cost
 *      on every response 'data' event (measured via the deterministic
 *      fakeReq + emit('data') pattern, buffered vs streaming).
 *
 * Verdicts are asserted against the signed-off anchors: request-path
 * added latency p50 < 1ms and p99 < 2% of the run's own measured baseline
 * p99 (a percentage-of-baseline anchor, so it is computed from the
 * reported baseline numbers, not hardcoded). A recorded budget miss is a
 * VALID completed outcome — the spec labels the verdict FAIL and still
 * commits the numbers; it never retries until green.
 *
 * The entire suite is gated behind RUN_BENCH: default `npm test` (and
 * each CI gate) skips it in milliseconds, while
 * `RUN_BENCH=1 npx jest src/benchmark.test.ts` runs the full measurement.
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { Interceptor } from './interceptor';

const REQUEST_BODY = JSON.stringify({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'hello there' }],
});

function startServer(): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            usage: { completion_tokens: 42 },
            choices: [{ message: { content: 'hello there' } }],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({
          server,
          port: address.port,
          close: () => new Promise<void>((res) => server.close(() => res())),
        });
      } else {
        throw new Error('no port');
      }
    });
  });
}

/** Fire one POST through the real http.request; resolves on response end. */
function singlePost(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end(REQUEST_BODY);
  });
}

/** Wait for the deferred (setImmediate) emission path to flush. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function nanoToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

/** Sort numbers ascending (Timsort — avoids the V8 comparator hazard). */
function sortedAsc(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** p-th percentile (linear interpolation), input MUST be pre-sorted. */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function p50(samples: number[]): number {
  return percentileSorted(sortedAsc(samples), 50);
}

function p99(samples: number[]): number {
  return percentileSorted(sortedAsc(samples), 99);
}

/**
 * Request-path harness: boots one server, then runs interleaved
 * baseline/intercepted samples in a single loop so JIT/GC drift cancels.
 * The intercepted sample takes an INSTALLED Interceptor configured with a
 * requestTransform, so the measured added latency reflects the real
 * patched write/end path including shouldCapture + transform work.
 */
async function measureRequestPath(): Promise<{
  baseline: number[];
  intercepted: number[];
}> {
  const { port, close } = await startServer();
  const baseline: number[] = [];
  const intercepted: number[] = [];
  const interceptor = new Interceptor({
    providers: ['127.0.0.1'],
    logger: noopLogger,
    requestTransform: (body: string) => body,
  });
  try {
    for (let i = 0; i < 1000 + 10000; i++) {
      if (i < 1000) {
        // Warmup: run both shapes before the measured loop so JIT/GC
        // reaches steady state for baseline and intercepted alike.
        await singlePost(port);
        interceptor.install();
        await singlePost(port);
        interceptor.restore();
        continue;
      }
      const t0 = process.hrtime.bigint();
      await singlePost(port);
      const t1 = process.hrtime.bigint();
      baseline.push(nanoToMs(t1 - t0));

      interceptor.install();
      const t2 = process.hrtime.bigint();
      await singlePost(port);
      const t3 = process.hrtime.bigint();
      interceptor.restore();
      intercepted.push(nanoToMs(t3 - t2));
      // The captured entry is emitted on a deferred setImmediate — let it
      // flush so the next iteration starts from a clean emission queue.
      await flush();
    }
  } finally {
    interceptor.restore();
    await close();
  }
  return { baseline, intercepted };
}

/**
 * Response-data path: drives capture with a fake ClientRequest + explicit
 * emit('response')/emit('data') events — the deterministic pattern from
 * interceptor.test.ts — so per-'data'-event appendChunk/parse+count cost
 * is isolated from network noise. Measures the buffered configuration and
 * the streaming configuration (event-stream-parser wired into the data
 * handler) so the streaming rewire's added per-event cost is visible.
 *
 * The interceptor is installed ONCE per configuration and the timed unit
 * is a single emit('data') — interceptor construction/install and
 * emission flush live outside the timed window, so the recorded cost is
 * the data-handler overhead alone.
 */
async function measureResponseDataPath(): Promise<{
  buffered: number[];
  streaming: number[];
}> {
  const ssePayload = buildSsePayload();
  const buffered: number[] = [];
  const streaming: number[] = [];
  const bInter = makeInterceptor();
  const sInter = makeInterceptor();
  bInter.install();
  sInter.install();
  try {
    // Warm up both configurations before the measured loop (JIT/GC).
    for (let i = 0; i < 1000; i++) {
      driveEvent(bInter, false, ssePayload);
      driveEvent(sInter, true, ssePayload);
    }
    // The deferred emissions from the warmup round-trips complete before
    // the measured window begins.
    await flush();
    // One warmed fakeReq/EventEmitter pair per track, reused for the
    // measured loop so per-iteration object allocation is not part of
    // the per-event cost being timed.
    const bCapReq = fakeReq();
    const sCapReq = fakeReq();
    const bRes = new EventEmitter() as unknown as http.IncomingMessage;
    const sRes = new EventEmitter() as unknown as http.IncomingMessage;
    (bRes.headers as Record<string, string>) = {
      'content-type': 'application/json',
      'content-length': String(ssePayload.length),
    };
    (sRes.headers as Record<string, string>) = {
      'content-type': 'text/event-stream',
    };
    bInter.attachCapture(bCapReq);
    sInter.attachCapture(sCapReq);
    (bCapReq as unknown as EventEmitter).emit('response', bRes);
    (sCapReq as unknown as EventEmitter).emit('response', sRes);
    for (let i = 0; i < 10000; i++) {
      const t0 = process.hrtime.bigint();
      (bRes as unknown as EventEmitter).emit('data', Buffer.from(ssePayload));
      const t1 = process.hrtime.bigint();
      buffered.push(nanoToMs(t1 - t0));

      const t2 = process.hrtime.bigint();
      (sRes as unknown as EventEmitter).emit('data', Buffer.from(ssePayload));
      const t3 = process.hrtime.bigint();
      streaming.push(nanoToMs(t3 - t2));
    }
  } finally {
    bInter.restore();
    sInter.restore();
  }
  return { buffered, streaming };
}

function makeInterceptor(): Interceptor {
  return new Interceptor({
    providers: ['api.example.com'],
    capturePayloads: true,
    logger: noopLogger,
  });
}

/**
 * Drive one capture cycle for warmup: fakeReq + response + one
 * emit('data') + emit('end'). Unused in the measured loop (see above).
 */
function driveEvent(
  interceptor: Interceptor,
  streaming: boolean,
  ssePayload: string,
): void {
  const req = fakeReq();
  interceptor.attachCapture(req);
  const res = new EventEmitter() as unknown as http.IncomingMessage;
  if (streaming) {
    (res.headers as Record<string, string>) = {
      'content-type': 'text/event-stream',
    };
  } else {
    (res.headers as Record<string, string>) = {
      'content-type': 'application/json',
      'content-length': String(ssePayload.length),
    };
  }
  (req as unknown as EventEmitter).emit('response', res);
  (res as unknown as EventEmitter).emit('data', Buffer.from(ssePayload));
  (res as unknown as EventEmitter).emit('end');
}

/** Build a realistic SSE body with several data events. */
function buildSsePayload(): string {
  const events = [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' there' } }] },
    { choices: [{ delta: { content: '!' } }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** Build a fake ClientRequest exposing only what attachCapture needs. */
function fakeReq(): http.ClientRequest {
  const req = new EventEmitter() as unknown as http.ClientRequest;
  (req as unknown as { hostname: string }).hostname = 'api.example.com';
  (req as unknown as { path: string }).path = '/v1/chat/completions';
  (req as unknown as { protocol: string }).protocol = 'https:';
  (req as unknown as { getHeader: () => string | undefined }).getHeader = () =>
    'api.example.com';
  return req;
}

function noopLogger(): void {
  // The benchmark measures interception overhead, not logging cost — a
  // no-op emission sink keeps the recorded numbers attributable to the
  // patched request/response path alone.
}

const RUN_BENCH = process.env.RUN_BENCH === '1';

function benchmarkSuite(): void {
  test('request path: p50/p99 added latency within the signed-off anchors', async () => {
    const { baseline, intercepted } = await measureRequestPath();
    const bP50 = p50(baseline);
    const bP99 = p99(baseline);
    const iP50 = p50(intercepted);
    const iP99 = p99(intercepted);
    const addedP50 = iP50 - bP50;
    const addedP99 = iP99 - bP99;
    const addedP99Pct = bP99 > 0 ? (addedP99 / bP99) * 100 : Infinity;

    console.log(
      `[bench:request] baseline p50=${bP50.toFixed(3)}ms p99=${bP99.toFixed(3)}ms | ` +
        `intercepted p50=${iP50.toFixed(3)}ms p99=${iP99.toFixed(3)}ms | ` +
        `added p50=${addedP50.toFixed(3)}ms p99=${addedP99.toFixed(3)}ms (${addedP99Pct.toFixed(2)}% of baseline)`,
    );

    // Anchors: p50 < 1ms, p99 < 2% of the run's own baseline p99.
    expect(addedP50).toBeLessThan(1);
    expect(addedP99Pct).toBeLessThan(2);
  }, 120000);

  test('response-data path: per-event cost visible for buffered and streaming', async () => {
    const { buffered, streaming } = await measureResponseDataPath();
    const bP50 = p50(buffered);
    const sP50 = p50(streaming);
    const streamingDeltaNs = (sP50 - bP50) * 1e6;

    console.log(
      `[bench:response-data] buffered p50=${bP50.toFixed(6)}ms | ` +
        `streaming p50=${sP50.toFixed(6)}ms | ` +
        `added per-event=${streamingDeltaNs.toFixed(1)}ns`,
    );

    // The methodology's response-data-point exists to make the parsing
    // cost visible — report, and do not let the assert gate the value.
    expect(sP50).toBeGreaterThanOrEqual(0);
  }, 120000);
}

if (RUN_BENCH) {
  describe('latency benchmark', benchmarkSuite);
} else {
  // Kept out of the default run: the full 11k-iteration measurement only
  // executes when RUN_BENCH=1 is set explicitly (--passWithNoTests means
  // skipping it here keeps the default gate fast and green).
  describe.skip('latency benchmark (opt-in: RUN_BENCH=1)', benchmarkSuite);
}
