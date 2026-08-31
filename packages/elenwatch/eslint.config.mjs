// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  {
    // The interceptor is adapter code that monkey-patches
    // ClientRequest.prototype.write/end. Aliasing `this` to a closure var
    // and returning reflectCall-derived values is idiomatic here; the
    // strict this-handling rules would force contortions that obscure the
    // intent.
    files: ['src/interceptor.ts'],
    rules: {
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      // We DELIBERATELY capture the prototype methods unbound: a bound
      // function locks `this` to the prototype, so calling it via
      // `.call(thisArg, ...)` would still forward `this = proto.prototype`
      // into Node's stream internals and crash. The runtime call-site is
      // `originalWrite.call(this, ...)` where `this` is the actual
      // ClientRequest instance — exactly what the unbound form requires.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // The interceptor tests intentionally poke at http internals (patching
    // ClientRequest.prototype, binding untyped method refs, async executors
    // with unused rejects). Typing-rule strictness here is noise.
    files: ['src/interceptor.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // The provider-parser tests iterate over fixture payloads whose types
    // are intentionally loose; typing strictness here is noise.
    files: ['src/provider-parser.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    // The logger tests perform source-string assertions and snapshot
    // console.log output; their typing strictness is noise.
    files: ['src/logger.test.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);