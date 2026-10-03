import 'server-only'

import type { User } from '@supabase/supabase-js'

import type { CookieStore } from './server.js'
import { createServerClient } from './server.js'

/**
 * The signed-in user, verified by the Supabase Auth server.
 *
 * Always `null` rather than throwing: an unauthenticated visitor is a normal
 * state for most routes, and callers would otherwise have to catch on every
 * page render.
 */
export async function getSessionUser(cookies: CookieStore): Promise<User | null> {
  const supabase = createServerClient(cookies)

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  // A failed verification means "not signed in", never "signed in as whoever the
  // cookie claims" — that distinction is the whole reason this uses `getUser()`.
  if (error) return null

  return user
}

/**
 * Throwing variant for routes that genuinely require a member.
 *
 * The error message deliberately avoids saying whether the id exists.
 */
export async function requireSessionUser(cookies: CookieStore): Promise<User> {
  const user = await getSessionUser(cookies)

  if (!user) {
    throw new Error('You need to be signed in to do that.')
  }

  return user
}
