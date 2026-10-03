import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * React rules shared by the web app and the extension UI.
 *
 * Only `eslint-plugin-react-hooks` is used. `eslint-plugin-react` is omitted
 * deliberately: its latest release (7.37.5) crashes under ESLint 10
 * (`context.getFilename is not a function`) and has not shipped an ESLint 10
 * compatible version. The rules it provides that we would actually want —
 * `prop-types` and JSX runtime conventions — are handled by TypeScript, which
 * already enforces prop types structurally and is compiled by Next.js with the
 * automatic runtime.
 *
 * The hooks rules are the ones worth keeping: a conditional hook call is a real
 * bug class that nothing else here would catch.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
]
