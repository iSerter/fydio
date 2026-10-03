import { envValidationError } from './errors.js'
import { clientEnvSchema, type ClientEnv } from './schema.js'

/**
 * Validate browser-visible environment variables.
 *
 * This module deliberately has **no** path to `SUPABASE_SERVICE_ROLE_KEY`,
 * `SUPABASE_JWT_SECRET`, `EXTENSION_TOKEN_SECRET` or any tuning knob. Those
 * names are not in `clientEnvSchema`, and a Client Component cannot reach them
 * without importing `@fydio/env/server`, which `import 'server-only'` makes a
 * build error under Next.js. The negative test in `client.test.ts` locks this in.
 */
export function parseClientEnv(source: Record<string, unknown> = process.env): ClientEnv {
  const result = clientEnvSchema.safeParse(source)

  if (!result.success) {
    throw envValidationError(result.error, 'Client environment')
  }

  return result.data
}

let cached: ClientEnv | undefined

/** Lazily-validated client env, memoised for the life of the process. */
export function getClientEnv(): ClientEnv {
  cached ??= parseClientEnv()
  return cached
}

/** Reset the memoised value. Test-only. */
export function resetClientEnvCache(): void {
  cached = undefined
}

export type { ClientEnv }
export { clientEnvSchema } from './schema.js'
export type { PlatformKind } from './schema.js'
