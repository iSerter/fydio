import 'server-only'

import { cookies } from 'next/headers'

import type { CookieOptions } from '@fydio/supabase'
import { getSessionUser, requireSessionUser } from '@fydio/supabase/session'
import { createServerClient } from '@fydio/supabase/server'

/**
 * Server helpers shared by every T03 route.
 *
 * `server-only` at the top: everything here needs the service-role-capable request
 * context, and an accidental import from a Client Component would either fail confusingly
 * or, worse, pull `SUPABASE_SERVICE_ROLE_KEY` toward the browser bundle. The marker turns
 * that into a build error.
 */

/**
 * The current request's cookie jar, as the `CookieStore` `@fydio/supabase/server` wants.
 *
 * Next 16 makes `cookies()` async, so this is awaited rather than passed directly. The
 * wrapper exists so every call site does not repeat the cast -- and so that when Next
 * changes the cookie API again, there is exactly one line to change.
 */
export async function cookieStore() {
  const jar = await cookies()

  return {
    getAll() {
      return jar.getAll()
    },
    set(name: string, value: string, options?: CookieOptions) {
      // `options ?? {}` rather than passing `options` through. `@supabase/ssr` types its
      // options as optional, but Next's `cookieStore.set` takes `cookie?: Partial<...>`, and
      // under `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to an
      // optional property. The two option shapes are structurally compatible, so an empty
      // object is the correct translation for "no options given".
      jar.set(name, value, options ?? {})
    },
    delete(name: string) {
      jar.delete(name)
    },
  }
}

/** A Supabase client scoped to the signed-in member. RLS applies. */
export async function memberClient() {
  return createServerClient(await cookieStore())
}

/** The signed-in user id, or `null`. */
export async function currentUserId(): Promise<string | null> {
  const user = await getSessionUser(await cookieStore())
  return user?.id ?? null
}

/**
 * The signed-in user's id, or throw.
 *
 * Used by route handlers that have already decided they need a member, so the failure is a
 * 401 the handler can catch rather than a null that flows into a query as `auth.uid() = null`
 * and returns "no rows" -- which reads like an empty result set rather than a refusal.
 */
export async function requireUserId(): Promise<string> {
  const user = await requireSessionUser(await cookieStore())
  return user.id
}