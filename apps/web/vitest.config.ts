import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  /**
   * Load the app's `.env` so the live-stack integration test can find the real values.
   *
   * Without this, `pnpm validate` (which Turbo runs without the ambient environment) would see
   * no `SUPABASE_URL` and silently skip every integration assertion even when a stack and a dev
   * server are both running. Turbo does not forward `.env` to tasks.
   */
  envDir: '../..',
  envPrefix: ['SUPABASE_', 'NEXT_PUBLIC_', 'APP_URL', 'DATABASE_URL'],
  resolve: {
    alias: {
      /**
       * `server-only` throws on import outside a React Server Component graph. The guard is
       * real in `next build` and must stay there; Vitest only needs to be able to import the
       * modules that carry it. The same alias exists in `packages/env` and `packages/supabase`.
       */
      'server-only': fileURLToPath(new URL('../test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
})
