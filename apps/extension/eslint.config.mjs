import base from '@fydio/config-eslint/base'

export default [
  { ignores: ['dist/**', 'coverage/**', 'public/**'] },
  ...base,
  {
    languageOptions: {
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        MouseEvent: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLAnchorElement: 'readonly',
      },
    },
  },
]
