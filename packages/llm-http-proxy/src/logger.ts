/**
 * Pluggable logger seam.
 *
 * The `Logger` interface is the seam a future OTEL span exporter (and
 * every other consumer) plugs into. It accepts a fully-assembled
 * `LlmLogEntry` and emits it; nothing else. The default console adapter
 * emits the entry via JSON.stringify — never any raw payload, header,
 * or surrounding request object.
 *
 * The Logger interface MUST NOT pull in NestJS or any other framework
 * runtime — this is what keeps the package portable to non-Nest
 * consumers.
 */

import type { LlmLogEntry } from './options';

/** A pluggable sink for fully-assembled LLM log entries. */
export type Logger = (entry: LlmLogEntry) => void;

/**
 * Default console adapter: `console.log(JSON.stringify(entry))`. The
 * output is derived solely from the entry object — no references to the
 * underlying request, response, or headers are retained, so authorization
 * values and raw payloads can never leak via this adapter.
 *
 * The adapter is deterministic: same input → same output, no shared
 * counters or module-level state.
 */
export const consoleLogger: Logger = (entry: LlmLogEntry): void => {
  console.log(JSON.stringify(entry));
};

/** A no-op logger — handy for tests and for callers who want to disable emission. */
export const noopLogger: Logger = (): void => {
  /* intentionally empty */
};
