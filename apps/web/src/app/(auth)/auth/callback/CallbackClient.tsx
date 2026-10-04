'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { Card, Stack } from '@fydio/ui'
import { createBrowserClient } from '@fydio/supabase/browser'

import { safeNextPath } from '@/lib/next-path'

/**
 * Completes a magic-link or PKCE sign-in in the browser (T03).
 *
 * WHY THE CLIENT, AND NOT A ROUTE HANDLER. Auth redirects with the session in the fragment,
 * and a fragment is not sent to the server. This is the only place the credentials exist, so
 * this is the only place they can be read -- and then they are immediately handed to
 * supabase-js, which writes the session cookie, after which nothing in the URL matters.
 *
 * The fragment is scrubbed with `replaceState` as soon as it has been read. Leaving it in
 * `window.location` means a screenshot, a browser-history entry, or any later code that reads
 * the URL can recover a live session token.
 */
export function CallbackClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function complete() {
      const destination = safeNextPath(searchParams.get('next'))
      const code = searchParams.get('code')

      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
      const accessToken = fragment.get('access_token')
      const refreshToken = fragment.get('refresh_token')

      // Scrub first, unconditionally. If the exchange below throws, the credentials are still
      // gone from the address bar rather than sitting there for anything to pick up.
      window.history.replaceState(null, '', window.location.pathname + window.location.search)

      // Two credential shapes, one URL. The fragment is what an emailed magic link delivers;
      // `?code=` is what a PKCE exchange delivers. Both must be handled, and neither can be
      // reached from a Route Handler.
      const hasFragmentSession = accessToken !== null && refreshToken !== null

      // Neither shape present. The browser already consumed the token, so there is nothing to
      // exchange -- hand off to the destination and let the proxy decide what an anonymous
      // member is allowed to see.
      if (!hasFragmentSession && code === null) {
        router.replace(destination)
        return
      }

      const supabase = createBrowserClient()

      const { error } = hasFragmentSession
        ? await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        : await supabase.auth.exchangeCodeForSession(code ?? '')

      if (cancelled) return

      if (error !== null) {
        setMessage('That sign-in link has expired or was already used. Request a new one.')
        return
      }

      // A full navigation, not `router.replace`. The session cookie was just written by a
      // third-party client the server has never seen, so only a server-rendered request will
      // make the proxy re-evaluate this member's access.
      window.location.assign(destination)
    }

    void complete()

    return () => {
      cancelled = true
    }
  }, [router, searchParams])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <Card title={message === null ? 'Signing you in' : 'That did not work'}>
        <Stack gap={2}>
          {message === null ? (
            <p role="status" className="text-sm text-ink-muted">
              One moment &mdash; finishing your sign-in.
            </p>
          ) : (
            <>
              <p role="alert" className="text-sm text-critical">
                {message}
              </p>
              <a
                href="/login"
                className="inline-flex w-fit items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
              >
                Request a new link
              </a>
            </>
          )}
        </Stack>
      </Card>
    </main>
  )
}
