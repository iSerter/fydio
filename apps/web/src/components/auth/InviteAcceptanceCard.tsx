'use client'

import { useEffect, useRef, useState } from 'react'

import { Card, Stack } from '@fydio/ui'
import { createBrowserClient } from '@fydio/supabase/browser'

/**
 * Completes account creation from an invitation (T03).
 *
 * Posts the token to `POST /api/auth/accept-invite`, which is the only route that can
 * create an account. This component's job afterwards is to turn the returned one-time token
 * into a browser session.
 *
 * WHY THE TOKEN GOES IN THE URL FRAGMENT. A fragment is not sent to the server and is not
 * included in `Referer`, so a single-use session credential never appears in an access log
 * or in the headers of any third-party request the page might make. `redirectTo` therefore
 * navigates to `/auth/callback#<token>` rather than `?<token>`.
 */
export function InviteAcceptanceCard({ token }: { token: string }) {
  const [phase, setPhase] = useState<'working' | 'error'>('working')
  const [message, setMessage] = useState('')

  // Strict mode runs effects twice in development; without this guard the invitation would
  // be POSTed twice and the second attempt would report "already used" to a member whose
  // account was in fact created. The `attempted` ref is the cheapest correct fix.
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current) return
    attempted.current = true

    async function accept() {
      const response = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setPhase('error')
        setMessage(readError(payload) ?? 'That invitation could not be redeemed.')
        return
      }

      const result = payload as { signedIn?: boolean; sessionToken?: string }

      if (result.signedIn !== true || typeof result.sessionToken !== 'string') {
        // The account exists but the session could not be issued. /login is the correct
        // destination -- reporting failure would push the member to spend a second invite.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation
        window.location.assign('/login')
        return
      }

      const supabase = createBrowserClient()
      const { error } = await supabase.auth.verifyOtp({
        token_hash: result.sessionToken,
        type: 'magiclink',
      })

      if (error) {
        setPhase('error')
        setMessage('Your account was created, but we could not sign you in. Request a link below.')
        return
      }

      // A full navigation is deliberate: the session was just written by `verifyOtp`, so the
      // server must re-run the proxy's onboarding gate. A client-side push would render from
      // the client cache and land on the wrong page.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation
      window.location.assign('/onboarding')
    }

    void accept()
  }, [token])

  if (phase === 'working') {
    return (
      <Card title="Creating your account">
        <p role="status" className="text-sm text-ink-muted">
          Just a moment &mdash; setting up your membership.
        </p>
      </Card>
    )
  }

  return (
    <Card title="We could not complete that">
      <Stack gap={4}>
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
        <a
          href="/login"
          className="inline-flex items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
        >
          Go to sign in
        </a>
      </Stack>
    </Card>
  )
}

/** Pull the message out of an error response, tolerating a non-JSON body. */
function readError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null

  const error = (payload as { error?: unknown }).error

  return typeof error === 'string' ? error : null
}