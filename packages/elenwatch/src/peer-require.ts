/**
 * A `require` function that works in both the CommonJS and the ESM build.
 *
 * The optional peers (`undici`, `@opentelemetry/api`) are loaded lazily so a
 * consumer without them installed still gets a working package. The CommonJS
 * emit has a real `require` in scope; the ESM emit does not, and a bare
 * `require('undici')` there throws `require is not defined` — which the
 * surrounding try/catch then misreads as "peer absent", silently disabling
 * fetch capture and the OTEL logger even when the peers ARE installed.
 *
 * `createRequire` from `node:module` builds a real `require`. It is anchored
 * at the current working directory (the application root, where optional
 * peers are installed alongside elenwatch) rather than at `import.meta.url`,
 * because `import.meta` is a syntax error in the CommonJS output and this one
 * source file is compiled for both the CJS and the ESM tree.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

type PeerRequire = ReturnType<typeof createRequire>;

function buildPeerRequire(): PeerRequire {
  // The CJS build — and Jest, which runs the CommonJS transform — already
  // have a working `require` in module scope; use it directly.
  if (typeof require === 'function') {
    return require;
  }

  // ESM build: no `require` in scope. Synthesize one anchored at the
  // process's working directory so normal node_modules resolution finds the
  // optional peers installed alongside the host application.
  try {
    return createRequire(pathToFileURL(`${process.cwd()}/`).href);
  } catch {
    // Constructing the require should never fail, but if it does, hand back a
    // stub that behaves like an absent peer rather than throwing at import
    // time. Callers wrap every peer load in try/catch already.
    return (() => {
      throw new Error('peerRequire unavailable');
    }) as unknown as PeerRequire;
  }
}

/**
 * Lazily-resolvable `require` for the optional peer dependencies. Every call
 * site MUST wrap the load in try/catch and treat a throw as "peer absent".
 */
export const peerRequire: PeerRequire = buildPeerRequire();
