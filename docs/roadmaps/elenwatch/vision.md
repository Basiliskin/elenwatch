# elenwatch — Vision

## Objective
Ship a coherent sequence of `elenwatch` patch releases (0.2.1, then later versions) that
fix the in-process LLM provider traffic interceptor's correctness, memory, and packaging
hygiene — each fix landed with a real test, the published tarball clean, the public
API stable, and the package metadata publishable.

## Success definition
Every planning horizon of this project ships a coherent patch release where:

- the in-process capture pipeline correctly honors the user-supplied `providers`
  filter on every entry surface (fetch/undici today, any future surface tomorrow);
- captured request and response bodies have a configurable, operator-visible byte
  bound with a structured event when it trips, so a runaway provider cannot pin
  unbounded memory;
- the published tarball is clean (no dead test-only artifacts, no duplicate
  lockfiles, no hand-duplicated VERSION constant, no broken type references) and
  `arethetypeswrong` reports zero resolution failures;
- the package's CI runs `tsc`, `eslint`, and `jest` on every PR with the
  packageManager pinned for corepack determinism;
- the public API surface (`install`, `restore`, `Logger`, `InterceptorOptions`)
  remains stable across patch versions.

## domainShape
**technical** — library-internals plumbing (HTTP interceptor correctness,
body-buffering bounds, packaging metadata) with no business domain vocabulary;
the DDD bounded-context toolkit would only add ceremony.

## Why this shape
The codebase serves one purpose: intercept HTTP/HTTPS traffic to LLM providers
inside a Node process. There are no orders, users, payments, or workflows —
only HTTP interception machinery. Subsystem boundaries (interceptor,
configuration, build pipeline, packaging) replace bounded contexts.
