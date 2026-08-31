// Post-build step for the dual (CJS/ESM) build:
//
//   1. Write per-tree package.json type markers so Node resolves each
//      format from the correct entry regardless of the nearest
//      package.json scope.
//   2. Rewrite every relative import/export specifier in the emitted
//      dist/esm .js and .d.ts files to carry an explicit .js extension
//      (or /index.js for a directory target). TypeScript emits
//      extensionless relative specifiers (`from './interceptor'`), which
//      Node's ESM loader and a strict `nodenext` type resolution both
//      reject. Adding the extension in source would break ts-jest's
//      resolver, so the rewrite happens here, against emitted output
//      only — dist/cjs and src are never touched.
//   3. Verify the ESM tree: every index.*.js is a real module, and no
//      relative specifier anywhere under dist/esm (.js or .d.ts) is left
//      extensionless. Either failure exits non-zero and fails the build.
//
// The rewrite is idempotent: a specifier that already ends in a known
// extension is skipped, so running this script twice yields byte-
// identical output (npm runs `postbuild` both explicitly and via the
// lifecycle hook, so this matters).
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const esmDir = join(root, 'dist/esm');
const cjsDir = join(root, 'dist/cjs');

// `--verify-only` runs the ESM tree verification without the rewrite —
// used to prove the guard fails the build on its own when a relative
// specifier is left extensionless (e.g. after a regression in the
// rewrite step).
const verifyOnly = process.argv.includes('--verify-only');

const HAS_EXTENSION = /\.(m?js|cjs|json|node)$/;

if (!existsSync(esmDir) || !existsSync(cjsDir)) {
  console.error('postbuild: expected dist/esm and dist/cjs to exist');
  process.exit(1);
}

if (verifyOnly) {
  verifyEsmTree();
  process.exit(0);
}

writeFileSync(
  join(esmDir, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
);
writeFileSync(
  join(cjsDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);

// --- ESM relative-specifier rewrite -----------------------------------

// Walk every file in the tree, yielding absolute paths.
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

// Resolve one relative specifier against the file that contains it,
// inspecting the actual emitted dist/esm filesystem: a sibling file
// becomes `<spec>.js`; a directory containing index.js becomes
// `<spec>/index.js`.
const resolveSpecifier = (fileDir, spec) => {
  const asFile = join(fileDir, spec);
  const dirIndex = join(asFile, 'index.js');
  if (existsSync(asFile) && statSync(asFile).isDirectory()) {
    if (existsSync(dirIndex)) return `${spec}/index.js`;
    // A directory with no index.js is not a resolvable module target;
    // leave it for the verifier to flag rather than guess.
    return spec;
  }
  return `${spec}.js`;
};

// Match a module specifier in a real import/export position:
//   - `from '...'`            (import x from, export { x } from, export * from)
//   - `import('...')`         (dynamic import, any nesting)
//   - `import '...'`          (side-effect import)
// The `from`/`import` keyword is required, so a bare string literal used
// as data elsewhere in the code is never touched.
const SPECIFIER_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\2/g;

const rewriteSource = (src, fileDir) =>
  src.replace(SPECIFIER_RE, (match, keyword, quote, spec) => {
    if (HAS_EXTENSION.test(spec)) return match; // already extensioned — idempotent
    return `${keyword}${quote}${resolveSpecifier(fileDir, spec)}${quote}`;
  });

for (const file of walk(esmDir)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const src = readFileSync(file, 'utf8');
  const next = rewriteSource(src, join(file, '..'));
  if (next !== src) writeFileSync(file, next);
}

verifyEsmTree();

console.log(
  'postbuild: format markers written, ESM specifiers extensioned, ESM tree verified',
);

// --- ESM tree verification -------------------------------------------

// A relative specifier with no resolvable extension left in the tree
// means the rewrite missed something and the published ESM build (or a
// nodenext typecheck of the published types) would break. Also asserts
// every index.*.js is a real module. Exits non-zero on any failure so
// `npm run build` goes red. Runs after the rewrite in a normal build,
// or standalone via `node scripts/postbuild.mjs --verify-only`.
function verifyEsmTree() {
  const EXTENSIONLESS_RE =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]+)\1/g;

  let verifyFailed = false;

  const checkTree = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        checkTree(full);
        continue;
      }
      const isJs = entry.endsWith('.js');
      const isDts = entry.endsWith('.d.ts');
      if (!isJs && !isDts) continue;
      const src = readFileSync(full, 'utf8');

      if (
        isJs &&
        entry.startsWith('index.') &&
        !/^\s*(import|export)\b/m.test(src)
      ) {
        console.error(`postbuild: ESM dist file is not a module: ${full}`);
        verifyFailed = true;
      }

      for (const m of src.matchAll(EXTENSIONLESS_RE)) {
        const spec = m[2];
        if (!HAS_EXTENSION.test(spec)) {
          console.error(
            `postbuild: extensionless relative specifier '${spec}' in ${full}`,
          );
          verifyFailed = true;
        }
      }
    }
  };

  checkTree(esmDir);

  if (verifyFailed) {
    console.error('postbuild: ESM tree verification failed');
    process.exit(1);
  }
}
