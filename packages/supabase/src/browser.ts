import { createBrowserClient as createSupabaseBrowserClient } from '@supabase/ssr'

import { getClientEnv } from '@fydio/env/client'

import type { FydioClient } from './types.js'

/**
 * Browser Supabase client for Client Components.
 *
 * Returns a memoised singleton: constructing a second client in the same tab
 * means a second realtime connection and a second copy of the session cache, and
 * the two can disagree about whether the user is signed in.
 */
let cached: FydioClient | null = null

export function createBrowserClient(): FydioClient {
  if (cached !== null) return cached

  const env = getClientEnv()

  cached = createSupabaseBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      db: { schema: 'public' },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  )

  return cached
}

/** Drop the cached client. Test-only. */
export function resetBrowserClient(): void {
  cached = null
}
