import 'server-only'

import { createServerClient as createSupabaseServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'

import { getServerEnv } from '@fydio/env/server'

import type { FydioClient } from './types.js'

/**
 * Re-exported so callers do not have to depend on `@supabase/ssr` directly.
 *
 * `CookieStore.set` takes this type, so every call site that implements a `CookieStore`
 * needs it -- and making `@supabase/ssr` a direct dependency of the web app just to name one
 * type would duplicate the version pin that this package already owns.
 */
export type { CookieOptions }

/**
 * The subset of Next.js cookie handling this package needs.
 *
 * Declared structurally rather than importing `next/headers` so the package
 * stays testable in plain Node and so the contract is visible: any cookie store
 * that satisfies this shape works.
 */
export interface CookieStore {
  getAll(): { name: string; value: string }[]
  set(name: string, value: string, options?: CookieOptions): void
  delete?(name: string): void
}

/**
 * A Supabase client bound to the request's cookies, for RSC and Route Handlers.
 *
 * **Not memoised.** A per-request client is the whole point: two concurrent
 * requests from the same user must not share a cookie jar, or one user's session
 * could be read while serving another's response.
 */
export function createServerClient(cookies: CookieStore): FydioClient {
  const env = getServerEnv()

  return createSupabaseServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookies.set(name, value, options)
        }
      },
    },
    db: { schema: 'public' },
  })
}
