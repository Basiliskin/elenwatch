/**
 * Pack-and-import smoke test — horizon 2, phase 4
 * (add-pack-and-import-smoke-test).
 *
 * Every other build test in this package inspects files inside the
 * workspace. This one proves the artifact a consumer actually installs:
 * it runs `npm pack`, installs the resulting tarball into a throwaway
 * directory that has no link back to the workspace, then loads the bare
 * `elenwatch` specifier in two separate node child processes — one native
 * ESM `import('elenwatch')`, one CJS `require('elenwatch')` — and asserts
 * each child exits 0 with a real check on the loaded module object.
 *
 * A missing `.js` extension in the emitted dist/esm tree, or a bare
 * `require()` executing under ESM, makes the ESM child exit non-zero and
 * fails this test — which is the whole point: it is the only check that
 * exercises the published tarball the way Node's ESM loader will.
 *
 * When npm cannot be invoked the entire suite skips (it never fails and is
 * never a false pass), mirroring the undici optional-peer skip idiom used
 * elsewhere in this package.
 *
 * Relies on the `pretest` -> `npm run build` hook so dist/ is current when
 * `npm pack` runs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG_DIR = join(__dirname, '..');
const STEP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function npmAvailable(): boolean {
  try {
    execFileSync('npm', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Probe once, synchronously, before the suite is defined so we can pick
// describe vs describe.skip — the runner then reports "skipped", not a
// passed test that never ran and not a failure.
const NPM_OK = npmAvailable();
const describeMaybe = NPM_OK ? describe : describe.skip;

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * The module-shape assertion both children run. `m` is the loaded module
 * namespace: CJS binds it via `const m = require(...)`, ESM via the
 * dynamic import's `.then((m) => ...)`.
 */
const ASSERT_MODULE = `
  const okInterceptor = typeof m.Interceptor === 'function';
  const okVersion = typeof m.VERSION === 'string' && m.VERSION.length > 0;
  if (!okInterceptor || !okVersion) {
    console.error(
      'unexpected elenwatch module shape: ' +
        'Interceptor=' + typeof m.Interceptor +
        ' VERSION=' + typeof m.VERSION + ' (' + String(m.VERSION) + ')',
    );
    process.exit(1);
  }
  process.exit(0);
`;

function assertChildOk(r: SpawnSyncReturns<string>, label: string): void {
  if (r.error) {
    throw new Error(`${label}: failed to spawn node child: ${String(r.error)}`);
  }
  if (r.signal) {
    throw new Error(`${label}: child killed by signal ${r.signal}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `${label}: child exited with status ${String(r.status)}\n` +
        `--- child stderr ---\n${r.stderr}\n` +
        `--- child stdout ---\n${r.stdout}`,
    );
  }
}

describeMaybe('pack-and-import smoke test (published tarball)', () => {
  let installDir: string;

  beforeAll(() => {
    // 1. `npm pack` -> a real .tgz (not --dry-run) in its own temp dir.
    const packDir = mkTmp('elenwatch-pack-');
    const packStdout = execFileSync(
      'npm',
      ['pack', '--pack-destination', packDir],
      {
        cwd: PKG_DIR,
        encoding: 'utf8',
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const tgzName = packStdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.tgz'))
      .pop();
    if (!tgzName) {
      throw new Error(
        `could not determine packed tarball name from:\n${packStdout}`,
      );
    }
    const tgzPath = join(packDir, tgzName);

    // 2. Install that tarball into a fresh consumer dir under the OS temp
    //    root — no path, symlink, or workspace reference back to the repo.
    installDir = mkTmp('elenwatch-consumer-');
    writeFileSync(
      join(installDir, 'package.json'),
      `${JSON.stringify(
        { name: 'elenwatch-smoke-consumer', version: '1.0.0', private: true },
        null,
        2,
      )}\n`,
    );
    execFileSync(
      'npm',
      [
        'install',
        tgzPath,
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--prefer-offline',
      ],
      {
        cwd: installDir,
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }, STEP_TIMEOUT_MS * 2);

  afterAll(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it(
    'loads via a native ESM import() in a separate node process',
    () => {
      const script = `
        import('elenwatch')
          .then((m) => {${ASSERT_MODULE}})
          .catch((err) => {
            console.error(err && err.stack ? err.stack : String(err));
            process.exit(1);
          });
      `;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          cwd: installDir,
          encoding: 'utf8',
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        },
      );
      assertChildOk(result, 'ESM import("elenwatch")');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loads via a CJS require() in a separate node process',
    () => {
      const script = `
        const m = require('elenwatch');
        ${ASSERT_MODULE}
      `;
      const result = spawnSync(process.execPath, ['--eval', script], {
        cwd: installDir,
        encoding: 'utf8',
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      assertChildOk(result, 'CJS require("elenwatch")');
    },
    TEST_TIMEOUT_MS,
  );
});
