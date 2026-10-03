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
]
