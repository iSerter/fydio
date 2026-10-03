import 'server-only'

import { createClient } from '@supabase/supabase-js'

import { getServerEnv } from '@fydio/env/server'

import type { FydioClient } from './types.js'

let cached: FydioClient | null = null

/**
 * A `service_role` client. **Server-only.**
 *
 * This client bypasses RLS entirely — it can read and write every row, including
 * other members' private data and the credit ledger. Two rules follow from that
 * and are not negotiable:
 *
 *  1. It must never be constructed in code that can run in a browser. The
 *     `import 'server-only'` at the top of this file makes that a build error
 *     rather than a runtime leak.
 *  2. It must only be reached from code paths with a server-side authorisation
 *     decision behind them. It is for admin operations and scheduled jobs, never
 *     for "I could not work out whether this member is allowed to do this".
 *
 * For request-scoped work, use `createServerClient` instead — it runs as the
 * signed-in member and RLS applies.
 */
export function createServiceClient(): FydioClient {
  if (cached !== null) return cached

  const env = getServerEnv()

  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'public' },
    auth: {
      // A service-role client acts as no user and must never try to persist or
      // refresh a session; there is none.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  return cached
}

/** Drop the cached client. Test-only. */
export function resetServiceClient(): void {
  cached = null
}
