import { parseClientEnv } from '@fydio/env/client'
import { parseServerEnv } from '@fydio/env/server'

/**
 * Boot-time environment validation.
 *
 * Next.js calls `register()` once per server process, before any request is
 * handled. Validating here means a misconfigured deployment fails immediately
 * and loudly, rather than at the first request that happens to touch a missing
 * variable — and it happens before the page module is even imported, so the
 * error names the variable rather than surfacing as a `TypeError` deep in a
 * client factory.
 *
 * This is the one place in the app permitted to read `process.env` directly,
 * which the `fydio/no-process-env` lint rule encodes.
 */
// Next.js requires an async signature for `register`, but the body is
// deliberately synchronous: a bad environment must throw during startup rather
// than resolve and fail later on the first request that needs a variable.
export async function register(): Promise<void> {
  // The await is what makes this legitimately async; Next.js awaits `register`
  // during startup, so throwing here stops the server before it serves traffic.
  await Promise.resolve()

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      parseServerEnv()

      // The browser-visible variables are validated here too, not lazily in the
      // first Client Component that reads them. `NEXT_PUBLIC_*` values are baked
      // into the client bundle at build time, so a bad one otherwise survives the
      // build and only fails in the browser — where the stack trace is useless and
      // the build that shipped it is long gone.
      parseClientEnv()
    } catch (error) {
      // Log and rethrow: swallowing this would let the process start and fail
      // later on the first request that needs a variable.
      console.error('[fydio] Invalid environment at boot')
      throw error
    }
  }
}
