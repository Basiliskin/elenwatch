# elenwatch — Blockers

Append-only. Open questions left by earlier horizons; mark resolved in
place with a `— resolved by decision <date>` suffix when closed.

- 2026-08-31 | horizon 2 | Did every horizon-2 phase land green? Horizon 3 must re-derive from the real post-horizon-2 tree and the af0109a..HEAD diff, not from the brief.
- 2026-08-31 | horizon 2 | Did postbuild's rewrite touch BOTH dist/esm .js and .d.ts, and was a nodenext-consumer typecheck added? Decides whether CI needs a separate 'typecheck ESM .d.ts' job.
- 2026-08-31 | horizon 2 | Runtime cost / flakiness of the pack-and-import smoke test on GitHub runners (npm pack + install + node children) — CI timeout budget.
- 2026-08-31 | horizon 2 | Is 0.2.1 actually published to npm in horizon 3 (needs an NPM_TOKEN secret + a human decision) or does the horizon end at 'CI green + publish-ready'?
- 2026-08-31 | horizon 2 | Horizon-3 decisions: CHANGELOG format/location/granularity, CI matrix breadth (Node 18 vs +LTS), CI triggers, whether a CI job installs the undici peer so the fetch integration test runs.
- 2026-08-31 | horizon 2 | Should horizon 3 fix the LICENSE copyright holder, the author-email typo (dimitry.kazt@), the Basiliskin GitHub org in repository/bugs/homepage, and the stale 'horizon 3/4' labels in src/options.ts docstrings?
