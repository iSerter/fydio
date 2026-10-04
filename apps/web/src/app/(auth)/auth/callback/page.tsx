import type { Metadata } from 'next'

import { CallbackClient } from './CallbackClient'

export const metadata: Metadata = {
  title: 'Signing in | Fydio',
}

/**
 * Where a magic-link sign-in lands (T03).
 *
 * A PAGE rather than a Route Handler, and that change is load-bearing.
 *
 * GoTrue sends the session to the redirect target in the URL FRAGMENT -- `#access_token=...`
 * -- and a fragment is never transmitted to a server. A Route Handler therefore cannot see it,
 * which is not a limitation to work around but the reason the fragment is the right place for
 * a credential: it appears in no access log and in no `Referer` header on any request the page
 * makes. The only code that can read it runs in the browser, so this is a page whose client
 * component does the exchange.
 *
 * The previous Route Handler only understood `?code=`, so an emailed magic link produced a
 * redirect with no `code` and no session: the member was returned to `/login` with no error
 * anywhere. Sign-in appeared to work because the redirect target was briefly a real URL.
 *
 * Both shapes are handled by the client component, so one URL serves both flows.
 */
export const dynamic = 'force-dynamic'

export default function AuthCallbackPage() {
  return <CallbackClient />
}
