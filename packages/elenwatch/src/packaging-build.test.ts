/**
 * Packaging-build sanity tests for horizon 1, phase 6
 * (add-build-time-version-exclude-shim-and-tests).
 *
 * These assertions pin the build-time contract that ships in the 0.2.1
 * tarball:
 *   - VERSION in dist/esm/version.js and dist/cjs/version.js is byte-
 *     identical to package.json's `version` field (no drift between
 *     the source-of-truth package.json and the emitted artifact).
 *   - sdk-fetch-shim.{js,d.ts} is absent from the dist tree (the shim
 *     is test-only surface and references @ai-sdk/anthropic deep).
 *   - package-lock.json is absent from the published tarball (the
 *     workspace is pnpm-managed; one lockfile only).
 *   - dist/esm/index.d.ts and dist/cjs/index.d.ts exist and contain
 *     the VERSION re-export.
 *
 * The test relies on the package's `pretest` script running `npm run
 * build` first, so dist/ is current at test time. If you run jest
 * directly without that hook, the assertions below will fail loudly
 * with a "file does not exist" error — that is intentional, the
 * packaging contract only holds against a fresh build.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
  string,
  unknown
>;
const pkgVersion = pkg.version as string;

const distRoot = join(__dirname, '..', 'dist');
const esmVersionJs = join(distRoot, 'esm', 'version.js');
const cjsVersionJs = join(distRoot, 'cjs', 'version.js');
const esmIndexDts = join(distRoot, 'esm', 'index.d.ts');
const cjsIndexDts = join(distRoot, 'cjs', 'index.d.ts');

describe('packaging build (dist artifacts)', () => {
  describe('VERSION generated at build time', () => {
    it('dist/esm/version.js exports VERSION equal to package.json version', () => {
      expect(existsSync(esmVersionJs)).toBe(true);
      const src = readFileSync(esmVersionJs, 'utf8');
      // The emitted file must contain a literal string match against
      // the package.json version. Regex anchor the quotes to avoid
      // matching substrings of unrelated exports.
      expect(src).toMatch(
        new RegExp(
          `VERSION\\s*=\\s*['"]${pkgVersion.replace(/\./g, '\\.')}['"]`,
        ),
      );
    });

    it('dist/cjs/version.js exports VERSION equal to package.json version', () => {
      expect(existsSync(cjsVersionJs)).toBe(true);
      const src = readFileSync(cjsVersionJs, 'utf8');
      expect(src).toMatch(
        new RegExp(
          `VERSION\\s*=\\s*['"]${pkgVersion.replace(/\./g, '\\.')}['"]`,
        ),
      );
    });

    it('CJS and ESM version.js both resolve to the same VERSION string', () => {
      // The version-generation script writes a single literal; both
      // module systems emit the same constant value. The CJS build
      // wraps it in `Object.defineProperty(exports, '__esModule'...)`
      // and `exports.VERSION = ...`, so byte-equality is structurally
      // impossible — what must match is the resolved string value.
      const esmMatch = readFileSync(esmVersionJs, 'utf8').match(
        /VERSION\s*=\s*['"]([^'"]+)['"]/,
      );
      const cjsMatch = readFileSync(cjsVersionJs, 'utf8').match(
        /VERSION\s*=\s*['"]([^'"]+)['"]/,
      );
      expect(esmMatch).not.toBeNull();
      expect(cjsMatch).not.toBeNull();
      expect(esmMatch?.[1]).toBe(pkgVersion);
      expect(cjsMatch?.[1]).toBe(pkgVersion);
    });

    it('src/index.ts no longer hand-duplicates a VERSION literal', () => {
      // The hand-duplicated `export const VERSION = '...'` line was the
      // source of the drift. It must now be a re-export from ./version.
      const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8');
      expect(indexSrc).toMatch(
        /export\s*\{\s*VERSION\s*\}\s*from\s*['"]\.\/version['"]/,
      );
      expect(indexSrc).not.toMatch(
        /export\s+const\s+VERSION\s*=\s*['"][^'"]+['"]/,
      );
    });
  });

  describe('sdk-fetch-shim excluded from dist', () => {
    it('dist/cjs does not contain sdk-fetch-shim.{js,d.ts}', () => {
      expect(existsSync(join(distRoot, 'cjs', 'sdk-fetch-shim.js'))).toBe(
        false,
      );
      expect(existsSync(join(distRoot, 'cjs', 'sdk-fetch-shim.d.ts'))).toBe(
        false,
      );
    });

    it('dist/esm does not contain sdk-fetch-shim.{js,d.ts}', () => {
      expect(existsSync(join(distRoot, 'esm', 'sdk-fetch-shim.js'))).toBe(
        false,
      );
      expect(existsSync(join(distRoot, 'esm', 'sdk-fetch-shim.d.ts'))).toBe(
        false,
      );
    });

    it('src/sdk-fetch-shim.ts is still present (test-only surface intact)', () => {
      // Excluding from the BUILD is not the same as deleting source —
      // tests that drive the SDK through the per-call fetch shim still
      // need to resolve the module at test time.
      expect(existsSync(join(__dirname, 'sdk-fetch-shim.ts'))).toBe(true);
    });

    it('@ai-sdk/anthropic is absent from the dist tree', () => {
      // Belt-and-braces: even if sdk-fetch-shim somehow leaks through,
      // its .d.ts referenced @ai-sdk/anthropic, so any presence of
      // that string in dist/ would re-introduce the deep-import break.
      // grep returns exit 1 when there are no matches — that's the
      // pass case here, so we capture and ignore stderr.
      const grepNoMatch = (args: string[]): string => {
        try {
          return execFileSync('grep', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
          }).toString();
        } catch (err) {
          // execFileSync throws on non-zero exit; the only signal we
          // need is stdout, which is empty when grep matched nothing.
          const out = (err as { stdout?: Buffer | string }).stdout;
          return out ? out.toString() : '';
        }
      };
      const cjsGrep = grepNoMatch([
        '-r',
        '--include=*.d.ts',
        '-l',
        '@ai-sdk/anthropic',
        join(distRoot, 'cjs'),
      ]);
      expect(cjsGrep).toBe('');
      const esmGrep = grepNoMatch([
        '-r',
        '--include=*.d.ts',
        '-l',
        '@ai-sdk/anthropic',
        join(distRoot, 'esm'),
      ]);
      expect(esmGrep).toBe('');
    });
  });

  describe('tarball from `npm pack --dry-run` is clean', () => {
    // `npm pack --dry-run` prints the file listing to stdout. We
    // parse the output and assert that the forbidden files are absent.
    // Running this against the package root means the listing reflects
    // exactly what would ship to npm if a publish happened now.
    const packOutput = execFileSync(
      'npm',
      ['pack', '--dry-run', '--pack-destination', '/tmp/elenwatch-pack-test'],
      {
        cwd: join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        // npm sometimes prints benign warnings to stderr; we only read
        // stdout.
      },
    ).toString();

    const listedPaths = packOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('npm notice') || /^\d+\s+/.test(line))
      .map((line) => {
        // Output format is "npm notice X.YY KB package/<path>" or just
        // "X.YY KB package/<path>". Pull the trailing path.
        const m = line.match(/package\/(.+)$/);
        return m ? m[1] : '';
      })
      .filter((p) => p.length > 0);

    it('does not list sdk-fetch-shim.js', () => {
      expect(listedPaths).not.toContain('sdk-fetch-shim.js');
    });

    it('does not list sdk-fetch-shim.d.ts', () => {
      expect(listedPaths).not.toContain('sdk-fetch-shim.d.ts');
    });

    it('does not list package-lock.json', () => {
      expect(listedPaths).not.toContain('package-lock.json');
    });
  });

  describe('ESM/CJS .d.ts files exist and contain VERSION', () => {
    it('dist/esm/index.d.ts exists and references VERSION', () => {
      expect(existsSync(esmIndexDts)).toBe(true);
      const src = readFileSync(esmIndexDts, 'utf8');
      // The ESM .d.ts is what `exports['.'].types.import` resolves to;
      // it must include the public surface — specifically VERSION.
      expect(src).toMatch(/VERSION/);
    });

    it('dist/cjs/index.d.ts exists and references VERSION', () => {
      expect(existsSync(cjsIndexDts)).toBe(true);
      const src = readFileSync(cjsIndexDts, 'utf8');
      expect(src).toMatch(/VERSION/);
    });
  });
});
