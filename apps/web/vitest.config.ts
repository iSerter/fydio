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
  // `EXTENSION_TOKEN_SECRET` is in the list because `extension-tokens.test.ts`
  // signs and verifies real tokens against the configured secret. Without it the
  // suite would see an unconfigured module, skip, and report green for a signing
  // path nothing had exercised.
  envPrefix: ['SUPABASE_', 'NEXT_PUBLIC_', 'APP_URL', 'DATABASE_URL', 'EXTENSION_TOKEN_SECRET'],
  resolve: {
    alias: {
      /**
       * `@/*` → `src/*`, mirroring `tsconfig.json`'s `paths`.
       *
       * Vitest does not read `tsconfig.json`, so without this alias any test that
       * imports application code by its `@/` path fails to resolve — even though
       * the very same import works in `next build`. Mirrored here deliberately
       * rather than switched to a plugin: one line, no new dependency, and the
       * mapping stays visible next to the `server-only` alias it sits beside.
       */
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /**
       * `server-only` throws on import outside a React Server Component graph. The guard is
       * real in `next build` and must stay there; Vitest only needs to be able to import the
       * modules that carry it. The same alias exists in `packages/env` and `packages/supabase`.
       */
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
})
