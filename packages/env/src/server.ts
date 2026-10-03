import 'server-only'

import { envValidationError } from './errors.js'
import { serverEnvSchema, type ServerEnv } from './schema.js'

/**
 * Validate server environment variables.
 *
 * Pass `source` explicitly in tests; in production it defaults to `process.env`.
 * Returns the validated object rather than mutating anything, so a caller can
 * validate a candidate set without touching global state.
 */
export function parseServerEnv(source: Record<string, unknown> = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source)

  if (!result.success) {
    throw envValidationError(result.error, 'Server environment')
  }

  return {
    ...result.data,
    // Derived rather than trusted from the environment: an operator who sets
    // NODE_ENV=production in a `.env.local` should not accidentally get
    // production-only behaviour in a dev shell.
    isProduction: result.data.NODE_ENV === 'production',
  }
}

let cached: ServerEnv | undefined

/**
 * Lazily-validated server env, memoised for the life of the process.
 *
 * Deliberately lazy rather than a module-level constant: importing this module
 * from a build script or a test must not throw before the caller has had a
 * chance to supply input. `instrumentation.ts` calls `parseServerEnv()` at boot
 * so real deployments fail fast regardless.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv()
  return cached
}

/**
 * Reset the memoised value. Test-only — exported from the server entrypoint
 * rather than the package root so application code has no reason to call it.
 */
export function resetServerEnvCache(): void {
  cached = undefined
}

export type { ServerEnv }
export { serverEnvSchema, clientEnvSchema } from './schema.js'
export type { ClientEnv, PlatformKind } from './schema.js'
