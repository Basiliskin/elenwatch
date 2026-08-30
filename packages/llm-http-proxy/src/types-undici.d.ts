/**
 * Type shim for the optional `undici` peer dependency.
 *
 * Without this shim, `typeof import('undici')` in src/interceptor.ts would
 * fail to resolve at type-check time when the `undici` package is not
 * installed (current default state — undici is an OPTIONAL peer dep that
 * npm only installs when a consumer's package manager resolves it).
 *
 * The shim tells TypeScript that `import('undici')` has the same shape as
 * `import('undici-types')` (which IS transitively installed via
 * @types/node@22). At RUNTIME, `require('undici')` still resolves to the
 * real `undici` package when present (the API is compatible with the
 * types) or throws MODULE_NOT_FOUND when absent (caught by the lazy-require
 * try/catch in src/interceptor.ts).
 *
 * Mirrors the discipline used at src/otel.ts for the optional
 * `@opentelemetry/api` peer dep: type-only imports that resolve without
 * the runtime package being installed.
 */
declare module 'undici' {
  export * from 'undici-types';
}
