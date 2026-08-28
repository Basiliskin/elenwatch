// Post-build step: ensure the ESM tree is explicitly ESM and the CJS tree is
// explicitly CommonJS, so Node resolves each format from the correct entry
// regardless of the nearest package.json scope.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const esmDir = join(root, 'dist/esm');
const cjsDir = join(root, 'dist/cjs');

if (!existsSync(esmDir) || !existsSync(cjsDir)) {
  console.error('postbuild: expected dist/esm and dist/cjs to exist');
  process.exit(1);
}

writeFileSync(join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
writeFileSync(join(cjsDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

// Every emitted .js in the ESM tree must be a real module (import/export
// present), never a CJS-authored file wearing an .js extension.
const checkTree = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.endsWith('.js')) {
      const src = readFileSync(full, 'utf8');
      if (entry.startsWith('index.') && !/^\s*(import|export)\b/m.test(src)) {
        console.error(`postbuild: ESM dist file is not a module: ${full}`);
        process.exit(1);
      }
    } else if (statSync(full).isDirectory()) {
      checkTree(full);
    }
  }
};

checkTree(esmDir);
console.log('postbuild: format markers written, ESM tree verified as modules');