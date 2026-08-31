# Next-horizon brief — elenwatch (horizon 3)

Prepared by horizon 2's Stage 3.5. Horizon 2 fixes the external pre-publish review
(streamed-body wire truncation; broken ESM build; lint; cap-trip console.error;
prepublishOnly; full package README). Horizon 3 is the **CI + CHANGELOG** horizon that
turns the now publish-*ready* 0.2.1 into a CI-gated release.

## Unknowns (answer before planning horizon 3)

- Re-derive everything from the real post-horizon-2 tree and the `af0109a..HEAD` diff — not
  from this brief. Confirm every horizon-2 phase landed green.
- Final content of `packages/elenwatch/README.md` after horizon-2 phase 6 — horizon 3's README
  work is residual only (a pnpm-managed note, a CHANGELOG link, a CI badge).
- Did horizon-2 phase 3's postbuild rewrite touch **both** `dist/esm/*.js` and `*.d.ts`, and was
  a nodenext-consumer typecheck added to any tsconfig? Decides whether CI needs a separate
  "typecheck ESM .d.ts under nodenext" job.
- Runtime cost / flakiness of the new pack-and-import smoke test on GitHub-hosted runners
  (`npm pack` + `npm install <tarball>` + node children) — CI timeout budget.
- Should the LICENSE copyright holder, the `author` email (`dimitry.kazt@` looks like a typo),
  the `Basiliskin` GitHub org in repository/bugs/homepage, and the stale "horizon 3/4" labels in
  `src/options.ts` docstrings be corrected as housekeeping?
- Is 0.2.1 actually published to npm this horizon (needs an `NPM_TOKEN` secret + a human
  decision) or does the horizon end at "CI green + publish-ready"?

## Research (look at this before planning)

- **This is NOT a pnpm workspace.** There is no `pnpm-workspace.yaml`. The repo-root
  `package.json` + root `pnpm-lock.yaml` are a stale NestJS scaffold. The real package is
  `packages/elenwatch/` with its **own** `pnpm-lock.yaml` and `node_modules`. CI must run every
  step with `working-directory: packages/elenwatch`; `pnpm -r` / running from the repo root is
  wrong.
- `packages/elenwatch/package.json` pins: `engines.node: ">=18"`, `packageManager: "pnpm@10.12.1"`.
  CI `setup-node` + `pnpm/action-setup` should match (Node 18 floor; pnpm 10.12.1). No
  `engines.pnpm`.
- Scripts: `pretest` already runs a full `build`, so a CI `test` step implies `build`. `test` is
  `jest --passWithNoTests`; `typecheck` is `tsc -p tsconfig.json --noEmit`.
- No `.github/` directory, no husky/lefthook/pre-commit hooks anywhere — CI is greenfield.
- Jest `testRegex` collects all `src/*.test.ts` including the heavy `*.integration.test.ts` /
  `*.sdk.integration.test.ts` / `benchmark.test.ts` / `packaging-*.test.ts` / the new smoke test.
  Live-provider integration suites resolve to `describe.skip` without API keys (CI-safe, no
  secrets). `global-fetch-capture.integration.test.ts` skips when the optional `undici` peer is
  absent (undici is not a devDependency). So default `npm test` in CI runs unit + packaging +
  smoke only.
- `packages/elenwatch/.env` has real API keys but is gitignored and untracked — not a leak; CI
  does not need it.
- No `CHANGELOG.md` anywhere; no sibling package to mirror a convention from.
- The published README is `packages/elenwatch/README.md` (`files: ["dist","README.md","LICENSE"]`,
  publish is from the package dir). The repo-root README is not shipped.

## Decisions the next horizon must make

- **CHANGELOG format + location:** Keep-a-Changelog strict sections vs flat bullets;
  `packages/elenwatch/CHANGELOG.md` (add to `files`) vs repo-root. Recommendation:
  `packages/elenwatch/CHANGELOG.md`, added to `files`.
- **CHANGELOG granularity for 0.2.1:** one entry per review-finding category vs one bullet per
  sub-change. Re-derive from the actual horizon-2 commit diffs.
- **CI matrix shape:** single pinned Node 18 vs 18/20/22 vs `lts/*`. `engines.node: >=18` argues
  for at least 18 + one current LTS.
- **CI triggers:** `pull_request` + `push` to main only, vs also `workflow_dispatch` / tag. No
  npm secret exists — recommend verify-only, no publish job.
- **CI job composition:** steps with `working-directory: packages/elenwatch`,
  `pnpm install --frozen-lockfile` against `packages/elenwatch/pnpm-lock.yaml`, then
  `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`. Whether the pack-and-import
  smoke test runs as part of `pnpm test` (it does, via the jest regex) or as an explicit isolated
  step with its own timeout.
- Whether CI adds a dedicated job that installs the optional `undici` peer so
  `global-fetch-capture.integration.test.ts` actually executes instead of self-skipping.
- Whether to clean up or explicitly ignore the stale root `package.json` / `pnpm-lock.yaml`.

## Artifacts to inspect

`packages/elenwatch/package.json` (post-horizon-2 scripts incl. `prepublishOnly`),
`packages/elenwatch/pnpm-lock.yaml` (the real lockfile for `--frozen-lockfile`),
`packages/elenwatch/scripts/postbuild.mjs` (post-phase-3), `packages/elenwatch/README.md`
(post-phase-6), the new `pack-and-import.smoke.test.ts` (its npm-availability skip guard,
timeout, temp-dir cleanup), `src/packaging-build.test.ts` / `packaging-metadata.test.ts`,
`src/options.ts` docstrings (stale horizon labels), `src/index.ts` exports,
`git log --stat af0109a..HEAD`, the three tsconfigs, `eslint.config.mjs`, and the repo-root
`package.json` / `pnpm-lock.yaml`.

## Recommended next-horizon scope (one paragraph, not a phase list)

Turn the functionally-complete, packaging-fixed, documented 0.2.1 into a CI-gated, publish-ready
release. Two deliverables, both explicitly deferred to this horizon: (1)
`packages/elenwatch/CHANGELOG.md` — a Keep-a-Changelog 0.2.1 entry whose bullets are re-derived
from the actual `af0109a..HEAD` diff, added to `package.json` `files`; (2)
`.github/workflows/ci.yml` — a single verify-only workflow, all steps
`working-directory: packages/elenwatch` (NOT a pnpm workspace; the repo root is a stale NestJS
scaffold), `actions/checkout` + `pnpm/action-setup` pinned to pnpm 10.12.1 +
`actions/setup-node` pinned to Node 18 (optionally 18 + current-LTS matrix),
`pnpm install --frozen-lockfile` against `packages/elenwatch/pnpm-lock.yaml` with a pnpm-store
cache keyed on that lockfile, then `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`,
`pnpm test`. Triggers: `pull_request` + `push` to main; no publish job. Hold off on: publishing
to npm, richer README beyond horizon-2 phase 6, the "install elenwatch last" APM hook, richer
`restore()` diagnostics, any `onBodyDropped`/`Logger` structured-event redesign, narrowing the
redaction needle list, and true streaming for the request body — all deferred per horizon 2's
`deferred` list. Optionally, small housekeeping: LICENSE copyright holder, the author-email typo,
and the stale "horizon 3/4" labels in `src/options.ts`.
