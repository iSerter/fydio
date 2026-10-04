import base from '@fydio/config-eslint/base'

export default [
  {
    ignores: ['dist/**', 'coverage/**'],
  },
  ...base.map((config) => ({
    ...config,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        projectService: {
          allowDefaultProject: ['*.config.ts', '*.config.js'],
        },
      },
    },
  })),

  /**
   * The only two files in the repository permitted to read `process.env.X`.
   *
   * `no-restricted-syntax` exists so application code cannot hand-roll unvalidated config. This
   * package is the one place that validation lives, so the rule would otherwise forbid the fix
   * for the bug it exists to prevent.
   *
   * The exemption is per-file, not per-package, so a future module here still has to earn access.
   *
   * WHY THESE TWO NEED THE `process.env.X` FORM SPECIFICALLY -- and why this is not just a
   * style preference. A bundler substitutes `NEXT_PUBLIC_*` into a client bundle by replacing the
   * individual expressions `process.env.NEXT_PUBLIC_FOO` with literals. The shapes that dodge
   * the linter (`process.env` wholesale, or destructuring it) produce a bundle with nothing to
   * substitute, so every value arrives `undefined` in the browser and `clientEnvSchema` rejects
   * them at runtime -- a failure invisible to every unit test, since they all pass an explicit
   * source. `client.test.ts` guards the shape; see the note on the inlining test there.
   */
  {
    files: ['src/client.ts', 'src/server.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]
