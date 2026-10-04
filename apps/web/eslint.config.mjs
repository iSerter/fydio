import base from '@fydio/config-eslint/base'
import nextjs from '@fydio/config-eslint/nextjs'
import react from '@fydio/config-eslint/react'

export default [
  { ignores: ['.next/**', 'node_modules/**'] },
  ...base,
  ...react,
  ...nextjs,
  {
    // The live-stack integration test reads `process.env` to decide whether to run or skip.
    //
    // That is the test harness, not application code, and it must NOT go through the zod schema:
    // a partial environment should SKIP the suite, not throw a validation error that reads as a
    // broken test run. The same exemption exists in `packages/supabase/eslint.config.mjs` for its
    // `rpc.integration.test.ts`.
    files: ['test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
