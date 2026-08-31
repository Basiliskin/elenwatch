# elenwatch — Decisions

Append-only. One line per binding architectural choice. Re-litigating a
recorded decision is forbidden; the task text supersedes only with a
`risks[]` entry on the horizon that disagrees, never silently.

- 2026-08-31 | horizon 2 | The ESM build fix rewrites emitted dist/esm .js AND .d.ts specifiers to carry .js in scripts/postbuild.mjs, not by adding .js in source — source-level extensions break ts-jest resolution (no moduleNameMapper).
- 2026-08-31 | horizon 2 | Optional peers (undici, @opentelemetry/api) load via createRequire (node:module) with a mechanism compiling under BOTH tsconfigs — createRequire(import.meta.url) alone fails the CJS build.
- 2026-08-31 | horizon 2 | The pack-and-import smoke test loads elenwatch from the packed tarball in a temp dir (never workspace/dist), in separate ESM and CJS node children — a dist load passes even with broken published specifiers.
