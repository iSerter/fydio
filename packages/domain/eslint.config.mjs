import base from '@fydio/config-eslint/base'

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  ...base.map((config) => ({
    ...config,
    ignores: config.ignores ?? [],
  })),
]
