'use client'

import { useState, type SyntheticEvent } from 'react'

import { Card, Stack } from '@fydio/ui'
import { createBrowserClient } from '@fydio/supabase/browser'

interface JoinCodeFormProps {
  readonly code: string
}

export function JoinCodeForm({ code }: JoinCodeFormProps) {
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<'idle' | 'working' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || phase === 'working') return

    setPhase('working')
    setErrorMessage('')

    try {
      const response = await fetch('/api/auth/accept-invite-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, email: email.trim() }),
      })

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setPhase('error')
        setErrorMessage(readError(payload) ?? 'That invite could not be redeemed.')
        return
      }

      const result = payload as {
        ok?: boolean
        signedIn?: boolean
        sessionToken?: string
        redirectTo?: string
      }

      if (result.signedIn !== true || typeof result.sessionToken !== 'string') {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation
        window.location.assign('/login')
        return
      }

      const supabase = createBrowserClient()
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: result.sessionToken,
        type: 'magiclink',
      })

      if (verifyError) {
        setPhase('error')
        setErrorMessage(
          'Your account was created, but we could not sign you in. Request a link from sign-in.',
        )
        return
      }

      // Full navigation so proxy re-evaluates the newly written session cookies
      window.location.assign(result.redirectTo ?? '/onboarding')
    } catch {
      setPhase('error')
      setErrorMessage('Network error while redeeming invite code. Please try again.')
    }
  }

  return (
    <Card title="Enter your email">
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
      >
        <Stack gap={4}>
          <p className="text-sm text-ink-muted">
            We will use your email to sign you in. Fydio does not use passwords.
          </p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-medium text-ink">
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              disabled={phase === 'working'}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
              }}
              placeholder="you@example.com"
              className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
            />
          </div>

          {phase === 'error' && (
            <p role="alert" className="text-sm text-critical">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={phase === 'working'}
            className="inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {phase === 'working' ? 'Creating account…' : 'Create my account'}
          </button>
        </Stack>
      </form>
    </Card>
  )
}

function readError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const error = (payload as { error?: unknown }).error
  return typeof error === 'string' ? error : null
}
