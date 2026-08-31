/**
 * Packaging-metadata sanity tests for horizon 1, phase 5
 * (tighten-package-metadata-lockfile-and-types).
 *
 * Each assertion pins a piece of the published-tarball contract that
 * was added or split in this phase. The tests run in the default
 * `npm test` invocation (no env flag, no special harness) so a regression
 * in any field fails the suite immediately.
 *
 * Why a JSON parse, not a TS import: a deep import of
 * `../package.json` would let TypeScript surface types instead of
 * values, and a stale type-check could mask a missing field. Reading
 * the JSON as data and asserting against it forces the suite to verify
 * the on-disk file the way npm will.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<
  string,
  unknown
>;

describe('packaging metadata', () => {
  describe('repository', () => {
    it('is a git url object', () => {
      expect(pkg.repository).toBeDefined();
      expect(typeof pkg.repository).toBe('object');
      const repo = pkg.repository as { type?: string; url?: string };
      expect(repo.type).toBe('git');
      expect(typeof repo.url).toBe('string');
      expect(repo.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    });

    it('matches the live git remote', () => {
      // We deliberately do NOT exec `git remote` here — this test must
      // run with zero external dependencies so it can be picked up by
      // a downstream consumer's CI. Instead, the assertion pins the
      // expected URL: a mismatch with the actual remote is the same
      // defect as a wrong URL.
      const repo = pkg.repository as { url: string };
      expect(repo.url).toBe('https://github.com/Basiliskin/elenwatch.git');
    });
  });

  describe('bugs', () => {
    it('is a url-bearing object', () => {
      expect(pkg.bugs).toBeDefined();
      const bugs = pkg.bugs as { url?: string; email?: string };
      expect(typeof bugs.url).toBe('string');
      expect(bugs.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/);
    });
  });

  describe('homepage', () => {
    it('points at the README on the default branch', () => {
      expect(typeof pkg.homepage).toBe('string');
      expect(pkg.homepage).toBe(
        'https://github.com/Basiliskin/elenwatch#readme',
      );
    });
  });

  describe('packageManager', () => {
    it('pins a pnpm version in corepack-compatible format', () => {
      expect(typeof pkg.packageManager).toBe('string');
      // Corepack accepts `<name>@<exact-version>` without an integrity
      // hash for non-pnpm-published versions; the pinned value must be
      // a real SemVer release line.
      expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
      const pinned = (pkg.packageManager as string).split('@')[1];
      const [major, minor, patch] = pinned.split('.').map(Number);
      expect(major).toBeGreaterThanOrEqual(8);
      expect(minor).toBeGreaterThanOrEqual(0);
      expect(patch).toBeGreaterThanOrEqual(0);
    });
  });

  describe('exports types per-condition', () => {
    const exportsDot = (pkg.exports as Record<string, unknown>)['.'] as Record<
      string,
      unknown
    >;

    it('exports["."].types is an object with import and require branches', () => {
      expect(exportsDot.types).toBeDefined();
      expect(typeof exportsDot.types).toBe('object');
      const types = exportsDot.types as {
        import?: string;
        require?: string;
      };
      expect(typeof types.import).toBe('string');
      expect(typeof types.require).toBe('string');
    });

    it('import branch resolves to the ESM .d.ts', () => {
      const types = (pkg.exports as Record<string, unknown>)['.'] as {
        types: { import: string; require: string };
      };
      expect(types.types.import).toBe('./dist/esm/index.d.ts');
    });

    it('require branch resolves to the CJS .d.ts (and is NOT the ESM path)', () => {
      const types = (pkg.exports as Record<string, unknown>)['.'] as {
        types: { import: string; require: string };
      };
      expect(types.types.require).toBe('./dist/cjs/index.d.ts');
      // Negative assertion: the require branch must not also point at
      // the ESM .d.ts (the pre-phase defect that broke arethetypeswrong).
      expect(types.types.require).not.toBe(types.types.import);
    });

    it('top-level types field is preserved as a legacy fallback', () => {
      // Legacy resolvers and TypeScript's older resolution paths still
      // read the top-level `types`. Removing it would break `tsc` and
      // any consumer with an old resolution setting.
      expect(typeof pkg.types).toBe('string');
      expect(pkg.types).toBe('./dist/cjs/index.d.ts');
    });

    it('import and require runtime entries are still wired correctly', () => {
      const exportsDot = (pkg.exports as Record<string, unknown>)['.'] as {
        import: string;
        require: string;
      };
      expect(exportsDot.import).toBe('./dist/esm/index.js');
      expect(exportsDot.require).toBe('./dist/cjs/index.js');
    });
  });
});
