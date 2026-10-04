import type { ReactNode } from 'react'

import { getSessionUser } from '@fydio/supabase/session'

import { cookieStore } from '@/lib/server'
import { AppNav } from './AppNav'

/**
 * The signed-in shell (T03).
 *
 * A route group, so `(app)` contributes nothing to the URL: `/feed`, `/onboarding`,
 * `/settings/*` and `/u/[handle]` are the paths, not `/(app)/feed`.
 *
 * WHY THE LAYOUT DOES NOT DO THE AUTH CHECK. The proxy already refuses anonymous visitors and
 * redirects un-onboarded members, before any layout renders. Re-checking here would mean two
 * implementations of the same rule; worse, a layout check would not run for a route that
 * overrides it, so the pages that DID check would be the ones nobody thought about.
 *
 * The user id is passed to the nav so it can hide member-only links. It is read with
 * `getSessionUser`, which returns `null` rather than throwing -- an unauthenticated render is a
 * normal state here, and the proxy will bounce it immediately afterwards.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser(await cookieStore())

  return (
    <div className="min-h-dvh">
      <AppNav userId={user?.id ?? null} />

      <div className="mx-auto w-full max-w-4xl px-6">{children}</div>
    </div>
  )
}