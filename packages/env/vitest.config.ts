import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // `import 'server-only'` throws by design when it is evaluated outside a
      // React Server Component graph, which includes Vitest. Aliasing it to a
      // no-op keeps the guard intact in the app build (where it is the real
      // protection) without making the server module untestable.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
