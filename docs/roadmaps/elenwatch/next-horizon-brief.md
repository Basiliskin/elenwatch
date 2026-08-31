# Next-horizon brief — elenwatch (horizon after this one)

This brief is for the **next** planner — not this one. It reduces the next planner's
uncertainty by surfacing what the kept phases shipped, what was deferred, what still
needs to be discovered, and what decisions the next horizon must make.

## What this horizon (just shipped) actually did

- **Phase 0 — `add-providers-filter-guard-fetch-path`:** Critical fix — fetch dispatch
  at `interceptor.ts:267` now runs `shouldCapture(syntheticReq, this.providers)`
  before `attachCapture`; non-provider hosts early-return without entering the
  capture pipeline. Negative fetch test in `interceptor.test.ts`.
- **Phase 1 — `fix-synthetic-getheader-lie`:** `interceptor.ts:258-260` falls back to
  `hostHeader` only for the `host` key now; other absent keys return `undefined`.
  Header-correctness test.
- **Phase 2 — `fix-streamed-request-body-race`:** `interceptor.ts:302-396` capture is
  awaited before `original.dispatch()` is called; onComplete cannot fire until
  capture is complete. Deterministic slow-upload race test.
- **Phase 3 — `add-maxbodybytes-cap-and-body-dropped-event`:** `options.ts` gets
  `maxBodyBytes` (default ~10 MiB) and `onBodyDropped` callback; `appendChunk`
  short-circuits further capture once a direction's byte counter trips the cap.
- **Phase 4 — `tighten-package-metadata-lockfile-and-types`:** `package.json` gets
  `repository`/`bugs`/`homepage`/`packageManager`; `package-lock.json` deleted;
  `exports.types` split per ESM/CJS; eslint-disable directives at `otel.ts:38` and
  `otel.test.ts:101` verified (removed iff lint passes without them).
- **Phase 5 — `add-build-time-version-exclude-shim-and-tests`:** `scripts/build-version.mjs`
  generates `src/version.ts` from `package.json`; `src/index.ts` re-exports from
  `./version`; `sdk-fetch-shim` excluded from `tsconfig.{cjs,esm}.json`; packaging-sanity
  test asserts `dist` VERSION matches `package.json` and tarball is clean.

## Unknowns (questions the next horizon should answer before planning)

- What is the final shape of `README.md` after the kept phases ship — does the new
  `maxBodyBytes` option, the providers-filter fetch-path guard, and the new Logger
  callback signature already appear in user-facing prose, or does the next horizon
  need to thread those new public API surfaces into the README from scratch?
- What does `packages/elenwatch/package.json`'s `engines.node` say today, and what
  does `packageManager` resolve to once the kept phases add it — without those two
  pins, what Node version and pnpm version should CI use?
- Is the repo a true pnpm workspace (`pnpm-workspace.yaml` + root-level `packages/`)
  such that CI must run from the repo root, or does the build stay inside
  `packages/elenwatch/`?
- What is the agreed Keep-a-Changelog granularity for `0.2.1` — one line per fix
  category (six categories) or one bullet per sub-fix (e.g., split out
  `'exports.types' now points at 'dist/esm/index.d.ts'` for the import condition)?
- Are the eslint-disable directives at `otel.ts:38` and `otel.test.ts:101` still
  load-bearing after the kept phases ran lint — if they were removed successfully,
  this is moot; if they were kept, the README/CHANGELOG entry shouldn't promise
  they were dropped.
- Does `npm pack --dry-run` actually produce a clean tarball (no sdk-fetch-shim, no
  package-lock.json, correct ESM/CJS .d.ts) under the kept phases — and did
  `arethetypeswrong` stop flagging the types condition — because the README/CHANGELOG
  text will need to describe what `0.2.1` actually shipped, not what was planned?
- What GitHub repo permissions exist today (branch protection on `main`, required
  status checks, secrets for npm publish) — CI without secrets is fine for
  tsc/lint/test, but the next horizon needs to know whether publishing is in scope
  or stays manual?
- Is there an existing CHANGELOG convention in this monorepo (other packages, root
  level) that the elenwatch CHANGELOG should mirror?
- What does the `LICENSE` file actually contain (full text, copyright year, holder
  name) — does it need any metadata fix to match the new `homepage`/`bugs` fields,
  or is it already correct?
- Does the project want CI to enforce the packaging-sanity test (VERSION drift, clean
  tarball) on every PR, or only on tag/release branches?

## Research (what to actually look at before planning)

- Read `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/README.md` end-to-end
  (only 33 lines) to confirm exactly which sections the next horizon must add:
  Limitations, Configuration (including `maxBodyBytes` default + `onBodyDropped`
  signature), `restore()` semantics, pnpm-managed note, and install/restore ordering
  for APM agents.
- Read `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/package.json` for
  `engines.node`, `peerDependencies`, `devDependencies`, scripts (`build`, `lint`,
  `test`, `typecheck`, `prebuild`), and the new `packageManager` pin — CI matrix
  choices depend on these.
- Read `/Users/dimitrykatz/workspace/elenwatch/pnpm-workspace.yaml` and
  `/Users/dimitrykatz/workspace/elenwatch/package.json` (root) to confirm whether CI
  must use `pnpm -r` or can scope to `packages/elenwatch` only.
- Read `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/src/options.ts`
  (the docstring at lines 78-111 plus the new `maxBodyBytes`/`onBodyDropped` fields
  added by the kept phases) so the README's Configuration section mirrors the
  canonical wording.
- Re-read `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/src/interceptor.ts`
  around lines 731-738 (`restore()` docstring), 833 (`onWrapper`), 854 (`writeWrapper`),
  882 (`endWrapper`), and 912-916 (`kWriteWrapper`/`kEndWrapper`/`kOnWrapper` tags)
  to ground the APM Limitations prose in actual code paths — the docs have to describe
  real behavior, not idealized behavior.
- Re-read `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/src/otel.ts:38-39`
  and `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/src/otel.test.ts:101-102`
  plus `/Users/dimitrykatz/workspace/elenwatch/packages/elenwatch/eslint.config.mjs`
  to confirm whether the eslint-disable directives were removed or kept in the kept
  phases — the next horizon should not contradict that decision in CHANGELOG.
- Inspect `/Users/dimitrykatz/workspace/elenwatch/.github/` (currently absent) and
  search the repo for any existing CI config, husky/lefthook, or pre-commit hooks —
  the next horizon's CI must compose with whatever already exists rather than
  override it.
- Inspect the kept phase's diff (via `git log --stat` and the staged/unstaged working
  tree at start of next horizon) to enumerate every fix category that must appear in
  CHANGELOG; do not write CHANGELOG from the brief alone.
- Run `npm pack --dry-run` from `packages/elenwatch/` post-kept-phases and inspect the
  file list — confirm `sdk-fetch-shim` and `package-lock.json` are absent and
  `dist/esm/index.d.ts` + `dist/cjs/index.d.ts` are present — so README/CHANGELOG
  claims match reality.
- Check pnpm version in use (look at `pnpm-lock.yaml`'s `lockfileVersion` and the new
  `packageManager` pin) and the Node version matrix compatible with `engines.node` —
  pick `pnpm/action-setup` and `actions/setup-node` pins that match.

## Decisions the next horizon must make

- **README structural choice:** expand the 33-line README into sections (Installation,
  Configuration, Limitations, API, Contributing) or keep the minimal style and add a
  single dense 'Notes' block. Each shape changes how much prose the next horizon writes
  and how discoverable the APM/byte-cap caveats are.
- **CHANGELOG location and format:** root-level `CHANGELOG.md` vs
  `packages/elenwatch/CHANGELOG.md`; Keep-a-Changelog strict (Added/Changed/Deprecated/
  Removed/Fixed/Security sections) vs flat bullet list. The horizon's task says
  Keep-a-Changelog but doesn't pin the path.
- **CI scope choice:** full matrix (Node × pnpm) vs single pinned version vs single
  pinned version with an `LTS` matrix entry; whether to add an integration-test job
  that boots a real HTTP server (the `global-fetch-capture.integration.test.ts` is
  referenced) or keep CI unit-only.
- **CI workflow trigger scope:** PR + push to main only, vs also include
  `workflow_dispatch` and tag-triggered release builds. No secrets today, so no npm
  publish job — but the next horizon must decide whether to leave a placeholder
  publish job or omit it entirely.
- **Whether the 0.2.1 documentation + CI ships in the same release as the functional
  fixes (single coherent release) or as a follow-up 0.2.2 / patch — the kept phases
  produce a working 0.2.1 functionally, but without docs/CI it isn't a publishable
  release.**
- Whether the APM Limitations section should additionally warn that elenwatch cannot
  reliably peel another wrapper off `write`/`end` once dd-trace/newrelic have stacked
  on top (a stronger invariant) or only describe ordering ('install last') — the first
  is more honest, the second is less alarming; the next horizon picks.
- Whether `onBodyDropped` gets documented as a structured event with a typed info
  object (mirroring the `LlmLogEntry` shape) or as a callback that receives just the
  host + bytes-dropped + direction — the kept phases' decision on its signature
  dictates what the README can show.

## Files worth a fresh look

- `packages/elenwatch/README.md`
- `packages/elenwatch/package.json`
- `pnpm-workspace.yaml`
- `package.json` (repo root)
- `packages/elenwatch/src/options.ts`
- `packages/elenwatch/src/interceptor.ts`
- `packages/elenwatch/src/logger.ts`
- `packages/elenwatch/src/otel.ts`
- `packages/elenwatch/src/otel.test.ts`
- `packages/elenwatch/eslint.config.mjs`
- `packages/elenwatch/.gitignore`
- `packages/elenwatch/tsconfig.cjs.json`
- `packages/elenwatch/tsconfig.esm.json`
- `packages/elenwatch/LICENSE`
- `packages/elenwatch/scripts/build-version.mjs`
- `packages/elenwatch/src/index.ts`

## Recommended next-horizon scope (one paragraph, not a phase list)

The next horizon should turn the functional 0.2.1 into a publishable, CI-gated 0.2.1
release — it should add a Keep-a-Changelog CHANGELOG entry enumerating every fix the
kept phases actually shipped (re-derived from the working tree, not the brief), expand
README.md with Limitations (APM install-order caveat, restore()'s inability to peel
post-install wrappers), Configuration (maxBodyBytes default ~10 MiB, onBodyDropped
signature), and a pnpm-managed note, and add a minimal `.github/workflows/ci.yml`
(actions/checkout + pnpm/action-setup pinned to the packageManager field +
actions/setup-node pinned to a version compatible with engines.node, running
`pnpm install --frozen-lockfile`, `pnpm -r tsc`, `pnpm -r lint`, `pnpm -r test`, with
pnpm-store cache keyed on the lockfile). It should hold off on richer README sections
(full API reference, examples, troubleshooting), on any release/publish automation, on
the 'peel me first' APM hook, on richer restore() diagnostics beyond a documentation
caveat, and on any per-host/regex-anchoring policy extensions until the
`decisionsNeeded` above (README structure, CHANGELOG path, CI matrix shape) are
explicitly picked.
