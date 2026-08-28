# Binding decisions
- 2026-08-28 | horizon 1 | domain-shape-fit for llm-http-proxy is 'technical' (interception/parsing/redaction machinery, no business rules) — because the whole DDD/layering checklist for later horizons keys off this classification
- 2026-08-28 | horizon 1 | the extension-seams requirement is shipped as interface-only extension points, never built-in retries/streaming/TLS/WS/auth providers — because YAGNI gate 3 has no second implementation on the horizon
- 2026-08-28 | horizon 1 | latency benchmark, transformer pipeline, and OTEL exporter are full-objective success bars deferred to horizon 2, not dropped — because horizon-0 successCriteria explicitly do not certify them and the deferred entries carry the markers
