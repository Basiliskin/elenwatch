# Next-horizon brief (for horizon 2) — prepared Stage 3.5, horizon 1

## Unknowns
- Has an npm package name/version/license been chosen and verified available (npm view) for packages/<name>/, or is it still open?
- Is there a concrete signed-off latency budget and benchmark methodology (numbers, hardware, method), or still un-made?
- Does the new interceptor keep the existing public contract verbatim (LlmLoggingOptions providers/logger/tokenCounter + LlmLogEntry) plus additive seams, or may the API break before consumers commit?
- When capture is opted in, must log entries include the payload at all, or does 'no raw bodies by default' + configured-field masking satisfy the redaction bar?
- Must error-path emission records carry the four default capabilities (model/tokens/url/callerTrace) or may they be a reduced shape?
- Are consumers presumed plain Node ESM, CJS, or both — is dual-format actually required (only consumer is a CommonJS Nest app)?
- May benchmark/test infra touch root-level tooling (CI, root README) given rollback-safe scaffold requires root untouched?
- Does the write/end capture wrapper need to preserve exact req.write/req.end return semantics incl. callback/encoding arg forwarding for streaming callers?
- Is the Error().stack caller-trace walk acceptable as shipped default, or is a source-mapped/frame-identified trace required?
- Is process-global monkey-patching of http/https.request acceptable for a general-audience npm package (coexisting-APM risk), or is a non-invasive alternative mandated before publishing?

## Research (before planning horizon 2)
- Inspect packages/<name>/ after horizon 1: git status, npm pack --dry-run, plain-Node require()/import() smoke — plan publish-verification against the real artifact.
- Re-check src/llm-http-logging/llm-http-interceptor.service.ts lines 109-111 (empty error handler) and 150 (req.protocol url bug) — confirm horizon-1 interceptor-core actually fixed them before transformer Content-Length work.
- Read packages/<name>/package.json + jest config vs root Nest config — confirm dual ESM/CJS build and standalone lockfile before multi-node/publish work.
- Run npm view <chosen-name> / npm whoami to check registry availability and auth state before publish-verification.
- Re-read src/llm-http-logging/llm-http-logging.module.ts and src/app.module.ts once the package grows to check LlmHttpLoggingModule.register still compiles before nest-adapter-and-migration.
- Check git status for root workspace drift (README/package.json/eslint.config.mjs) if docs/CI work is considered.
- Re-read the payload-redaction default-no-raw rubric to confirm what 'no raw sensitive value in any emitted entry' covers when deciding whether a custom Logger can leak past redaction.

## Decisions needed (horizon 2 cannot avoid these)
- Package identity: name, initial version, license, and whether it may become a public registry package at all.
- Latency budget + benchmark methodology: explicit numbers and fixture/hardware/measurement definition.
- TS-consumer contract: whether published LlmLogEntry/LlmLoggingOptions API is semver-frozen before adapter/docs work.
- Process-patch strategy: global monkey-patching acceptable to ship, or less invasive approach required before publish.
- Monorepo regime: root workspaces/proxies or full isolation under packages/<name> — determines CI/matrix staging.
- Redaction scope: 'no raw bodies' as strict opt-in capture vs. hard payload-layer guarantee inherited by all emission paths.
- Extension-seam posture: streaming/SSE/TLS/retries/auth/proxy as first-class features or interface-only per the horizon-1 assumption.

## Artifacts to inspect
- packages/<name>/ (after horizon 1 completes)
- src/llm-http-logging/llm-http-interceptor.service.ts
- src/llm-http-logging/llm-http-logging.module.ts
- src/app.module.ts
- package.json / tsconfig.json / eslint.config.mjs (root, for drift)
- docs/roadmaps/llm-http-proxy/horizons/horizon-01-llm-http-proxy-roadmap.json (deferred entries + rubric bars)

## Recommended next-horizon scope
The next horizon should attempt roughly three to four phases, front-loading the two unresolved required
materials — package identity and a signed-off latency budget — because most deferred work dangles off them.
Engineering-wise, take the transformer pipeline and the fixture-based latency benchmark together (they pair:
the benchmark must prove the Content-Length/mutation work stays off the request path), then follow with
publish-verification (pack dry-run, non-Nest consumer sandbox, Node 18/20/22 matrix) once package content is
final. Hold off on the Nest adapter/migration, package documentation, and the OTEL span exporter until the
public API (LlmLogEntry/LlmLoggingOptions and the Logger seam) is declared frozen, and treat extension-seams
as out of reach until a second real implementation exists. The risks to guard: transformer Content-Length
accounting and the singleton/restore design of the interceptor core are the two places benchmark numbers can
quietly regress.
