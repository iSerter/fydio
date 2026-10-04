import { envValidationError } from './errors.js'
import { clientEnvSchema, type ClientEnv } from './schema.js'

/**
 * The browser-visible environment, assembled from STATIC member reads.
 *
 * WHY THIS IS AN EXPLICIT OBJECT RATHER THAN `process.env`.
 *
 * The bundler inlines `NEXT_PUBLIC_*` values by replacing the individual expressions
 * `process.env.NEXT_PUBLIC_FOO` with string literals. Passing the whole `process.env` object --
 * `parseClientEnv(process.env)` -- gives it nothing to replace, so in a client bundle every value
 * arrives `undefined` and `clientEnvSchema` rejects them at runtime. That failure is invisible
 * until a Client Component actually calls `getClientEnv()`, which is why it survived until T03
 * added the first browser-side Supabase client.
 *
 * Naming each variable also makes this module an ALLOWLIST rather than a pass-through: there is
 * no way for an unexpected key in the environment to reach a browser bundle through here, which is
 * the property the module's own header claims.
 *
 * `parseClientEnv` still accepts an explicit `source`, so the tests can validate a candidate set
 * without touching `process.env`.
 */
function readClientEnv(): Record<string, unknown> {
  return {
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_EXTENSION_ID: process.env.NEXT_PUBLIC_EXTENSION_ID,
  }
}

/**
 * Validate browser-visible environment variables.
 *
 * This module deliberately has **no** path to `SUPABASE_SERVICE_ROLE_KEY`,
 * `SUPABASE_JWT_SECRET`, `EXTENSION_TOKEN_SECRET` or any tuning knob. Those
 * names are not in `clientEnvSchema`, and a Client Component cannot reach them
 * without importing `@fydio/env/server`, which `import 'server-only'` makes a
 * build error under Next.js. The negative test in `client.test.ts` locks this in.
 */
export function parseClientEnv(source: Record<string, unknown> = readClientEnv()): ClientEnv {
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
