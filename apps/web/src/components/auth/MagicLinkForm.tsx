'use client'

import { useState, type SyntheticEvent } from 'react'

import { Button, Card, Stack } from '@fydio/ui'
import { createBrowserClient } from '@fydio/supabase/browser'

/**
 * The sign-in form (T03).
 *
 * Magic link only. There is no password field and no "create account" link, because the
 * product is invite-only and Auth sign-up is disabled at the stack level
 * (`DISABLE_SIGNUP=true`). A member who arrives without an invitation has no path through
 * this page, which is the intended behaviour rather than a missing feature.
 *
 * WHY THE CLIENT DOES THIS CALL RATHER THAN A SERVER ACTION: `signInWithOtp` sends an
 * email, and the browser needs the response to tell "sent" from "rate limited". It is a
 * public endpoint guarded by GoTrue's own rate limiter, so no session or secret is
 * involved.
 */
export function MagicLinkForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    setStatus('sending')
    setMessage('')

    const supabase = createBrowserClient()

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // Send the member back to the app rather than to a generic landing page. The
        // callback route exchanges the token and honours the same `next` parameter this
        // form was rendered with.
        emailRedirectTo: buildRedirectUrl(nextPath),
        shouldCreateUser: false,
      },
    })

    if (error) {
      setStatus('error')
      // With sign-up disabled, GoTrue answers a request for an address that has no
      // account with a rate-limit or "signups not allowed" error. The wording below is
      // deliberately vague about WHICH, because confirming "this address has no account"
      // turns the login page into a way to enumerate who was invited.
      setMessage(
        /rate|limit|too many/i.test(error.message)
          ? 'Too many sign-in links requested. Wait a minute and try again.'
          : 'That address cannot sign in yet. If you were invited, open the link in your email.',
      )
      return
    }

    setStatus('sent')
  }

  return (
    <Card title="Sign in">
      <form onSubmit={(event) => { void onSubmit(event); }} className="flex flex-col gap-4">
        <Stack gap={2}>
          <label className="text-sm font-medium text-ink" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => { setEmail(event.target.value); }}
            placeholder="you@example.com"
            className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </Stack>

        <Button type="submit" disabled={status === 'sending' || email.trim() === ''}>
          {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </Button>

        {status === 'sent' ? (
          <p role="status" className="text-sm text-positive">
            Check {email} for a sign-in link. It expires shortly and can only be used once.
          </p>
        ) : null}

        {message ? (
          <p role="alert" className="text-sm text-critical">
            {message}
          </p>
        ) : null}
      </form>
    </Card>
  )
}

/**
 * Where Auth should send the member after they click the emailed link.
 *
 * Built against the browser's current origin rather than a build-time constant so the same
 * image works on localhost and on the deployed domain. Auth validates the result against
 * its configured allow-list, so an attacker-supplied origin here cannot be used to have
 * Fydio mail a link to a domain the operator did not register.
 */
function buildRedirectUrl(nextPath: string): string {
  const callback = new URL('/auth/callback', window.location.origin)
  callback.searchParams.set('next', nextPath)
  return callback.toString()
}