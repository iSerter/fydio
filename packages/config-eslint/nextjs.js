import next from '@next/eslint-plugin-next'

/**
 * Next.js App Router rules, layered on top of `react.js`.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@next/next': next,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
    },
  },
]
