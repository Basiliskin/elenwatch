# Open questions
- 2026-08-28 | horizon 1 | package name/version/license not chosen — open package-identity decision blocks scaffold manifest
- 2026-08-28 | horizon 1 | explicit latency budget + benchmark methodology not signed off (numbers/hardware/method) — blocks horizon-2 latency-benchmark gate
- 2026-08-28 | horizon 1 | is the public LlmLogEntry/LlmLoggingOptions API semver-frozen before horizon-2 adapter/docs work, or free to evolve?
- 2026-08-28 | horizon 1 | is process-global http/https monkey-patching acceptable to ship, or is a less invasive seam mandated before publish?
- 2026-08-28 | horizon 1 | may the root repo gain workspaces/CI, or must the package stay fully isolated under packages/ (rollback-safe)?
- 2026-08-28 | horizon 1 | under 'no raw bodies', is payload capture strictly opt-in or a hard guarantee all emission paths (incl. third-party loggers) inherit?
- 2026-08-28 | horizon 1 | are streaming/SSE/TLS/retries/auth/proxy seams ever to become first-class features or stay interface-only?
