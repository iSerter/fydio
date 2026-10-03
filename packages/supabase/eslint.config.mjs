import base from '@fydio/config-eslint/base'

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  ...base,
  {
    // The live-stack test reads process.env to decide whether to run or skip.
    // That is the test harness, not application code, and it must not go
    // through the zod schema — a partial environment should skip, not throw.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
