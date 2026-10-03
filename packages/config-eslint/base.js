/**
 * Fydio-specific lint rules.
 *
 * Kept in one place so the reasoning behind each rule — not just its
 * implementation — travels with it.
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Files permitted to read `process.env` directly.
 *
 * Config files and scripts run before any app module and have no access to the
 * env package's build output, so they are exempt by necessity. Everything else
 * goes through `@fydio/env`.
 */
const ENV_EXEMPT_FILES = [
  '**/instrumentation.ts',
  '**/next.config.ts',
  '**/*.config.ts',
  '**/*.config.mjs',
  '**/*.config.js',
]

/**
 * TypeScript-only base rules.
 *
 * Type-aware linting is enabled because the `no-process-env` rule below reads
 * type information to tell a genuine `process.env` member access apart from a
 * local variable that merely happens to be called `env`, so `projectService` is
 * required rather than optional.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/*.d.ts',
      // Generated from the database by `pnpm db:types`; not hand-written, so
      // linting it would only report on the generator's style, not ours.
      '**/types.generated.ts',
    ],
  },
  // ESLint 10 removed `extends` support in flat config, so the shareable
  // configs are spliced into this array instead of nested under an `extends` key.
  ...tseslint.configs.strictTypeChecked.map(withTypeScriptScope),
  ...tseslint.configs.stylisticTypeChecked.map(withTypeScriptScope),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      // Fydio runs on Node in every workspace (server, scripts, config loaders),
      // so Node globals are the baseline. Browser globals are layered on by the
      // React config, which only applies to the web app.
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // typescript-eslint documents disabling the core rule in favour of its
      // own, which understands type positions. Leaving both on produces
      // false positives for parameter names in a function *type*, where the
      // core rule sees an unused binding that does not exist at runtime.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // A floating promise is a silent data-loss bug in a credit ledger, so we
      // promote it to an error rather than typescript-eslint's default warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` erases exactly the guarantees the domain package exists to make.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    /**
     * The env contract, enforced structurally.
     *
     * `packages/env` is the only application code allowed to read `process.env`.
     * This rule is what makes "single source of truth" true rather than
     * aspirational: without it, any module could read an unvalidated, untyped
     * variable and quietly opt out of fail-fast boot behaviour.
     *
     * Config files are exempt because they run before any app module and have
     * no access to the env package's build output.
     */
    name: 'fydio/no-process-env',
    files: ['**/*.{ts,tsx,mts,cts}'],
    ignores: [
      ...ENV_EXEMPT_FILES,
      // `packages/env` is the one place that *should* read process.env.
      '**/packages/env/src/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message:
            'Do not read process.env here. Use getServerEnv()/getClientEnv() from @fydio/env so the value is validated and typed.',
        },
      ],
    },
  },
]

/**
 * Re-scope a shareable config to TypeScript files and drop any `extends` key
 * that a plugin may still be emitting.
 */
function withTypeScriptScope(config) {
  const { extends: _ignored, ...rest } = /** @type {any} */ (config)

  return {
    ...rest,
    files: ['**/*.{ts,tsx,mts,cts}'],
  }
}
