/**
 * Regression proof for horizon 2, phase 2
 * (createrequire-lazy-load-optional-peers).
 *
 * Blocker 2 (part): under a native ES module there is no `require` in
 * scope, so the old bare `require('undici')` / `require('@opentelemetry/api')`
 * threw `require is not defined`, the surrounding try/catch misread that as
 * "peer absent", and ESM consumers silently lost all fetch capture and the
 * OTEL logger even with the peers installed.
 *
 * `src/peer-require.ts` now builds a working `require` via `createRequire`
 * for the ESM emit. This test loads the built `dist/esm/peer-require.js` in a
 * real `node --input-type=module` child process (jest itself runs the
 * CommonJS transform and cannot exercise the ESM branch) and asserts the
 * synthesized require resolves both optional peers.
 *
 * Relies on the `pretest` -> `npm run build` hook so dist/ is current.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const esmPeerRequireJs = join(
  __dirname,
  '..',
  'dist',
  'esm',
  'peer-require.js',
);
const cjsPeerRequireJs = join(
  __dirname,
  '..',
  'dist',
  'cjs',
  'peer-require.js',
);

describe('peerRequire (dual CJS/ESM optional-peer loader)', () => {
  it('has a built ESM and CJS artifact', () => {
    expect(existsSync(esmPeerRequireJs)).toBe(true);
    expect(existsSync(cjsPeerRequireJs)).toBe(true);
  });

  it('resolves undici and @opentelemetry/api from a native ESM child process', () => {
    const script = `
      import { peerRequire } from ${JSON.stringify(esmPeerRequireJs)};
      const undici = peerRequire('undici');
      const otel = peerRequire('@opentelemetry/api');
      if (typeof undici.fetch !== 'function') { console.error('undici.fetch missing'); process.exit(1); }
      if (typeof otel.trace !== 'object') { console.error('otel.trace missing'); process.exit(1); }
      process.exit(0);
    `;
    // Throws (non-zero exit) and fails the test if the ESM branch regresses.
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: 'pipe',
      timeout: 30_000,
    });
  });

  it('the built ESM artifact contains no bare `require(` call and no `import.meta`', () => {
    // Strip block comments before scanning for code patterns.
    const code = readFileSync(esmPeerRequireJs, 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/import\.meta/);
  });
});
