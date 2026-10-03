import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  /**
   * Load the app's `.env` so the live-stack test can find the real values.
   *
   * Without this, `pnpm validate` (which Turbo runs without the ambient
   * environment) would see no `SUPABASE_URL` and silently skip the integration
   * test even when a stack is running. Turbo does not forward `.env` to tasks.
   */
  envDir: '../../',
  envPrefix: ['SUPABASE_', 'NEXT_PUBLIC_', 'DATABASE_URL'],
  resolve: {
    alias: {
      // See packages/env — the guard is real in `next build`; Vitest just needs
      // to be able to import the modules that carry it.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
