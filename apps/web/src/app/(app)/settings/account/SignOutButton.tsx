'use client'

import { useState } from 'react'

import { createBrowserClient } from '@fydio/supabase/browser'

import { Button } from '@fydio/ui'

/**
 * Sign out (T03).
 *
 * Uses the BROWSER client so Supabase's own sign-out runs -- which clears the local session and
 * tells the Auth server to invalidate the refresh token. A server action that only deleted the
 * cookies would leave a valid refresh token on the device, so the session would come back on
 * the next refresh.
 *
 * Then a hard navigation, not a router refresh: the proxy has to re-run and re-evaluate the
 * session, and a client-side transition would keep rendering the cached RSC payload.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false)

  /**
   * Ends the session, then leaves the page.
   *
   * A full navigation rather than a router push, deliberately: the proxy has to re-run and
   * re-evaluate the session, and a client-side transition would keep serving the cached RSC
   * payload for the page the member was on -- showing them a signed-in view after signing out.
   */
  async function signOut() {
    setBusy(true)

    try {
      const supabase = createBrowserClient()
      await supabase.auth.signOut()

      // A full navigation is the point: the proxy must re-run so the now-dead session is seen,
      // and a client-side push would keep the cached RSC payload for the page just left.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation
      window.location.assign('/login')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => {
        // `void` rather than `await`: `onClick` expects a void-returning handler, and an async
        // one is a floating promise the linter is right to refuse.
        void signOut()
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}