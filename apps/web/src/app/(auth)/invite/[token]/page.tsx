import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

export const metadata: Metadata = {
  title: 'Invitation | Fydio',
}

/**
 * Dynamic: the token is in the path, so this cannot be prerendered.
 */
export const dynamic = 'force-dynamic'

/**
 * The landing page for an emailed invitation link (T03).
 *
 * WHAT THIS DOES NOT DO. It does not redeem anything. It validates the token's SHAPE and
 * hands off to `/auth/accept`, which performs the actual claim.
 *
 * WHY NOT REDIRECT AUTOMATICALLY. The step exists so a member clicking a link in their mail
 * client sees a page from Fydio BEFORE anything is created. An automatic redirect would
 * mean a link that is merely clicked -- or link-previewed by a corporate mail scanner --
 * could create an account. Keeping the claim behind a deliberate page render and an
 * explicit button is what makes "an invitation must be opened by a person" true.
 *
 * The raw token is passed along in the query string rather than the path so the accept page
 * can render it without a second hop, and because a token in a URL fragment would never
 * reach the server at all.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // Shape check only. A 64-character hex string is what `generateInviteToken` produces, so
  // anything else is not one of ours -- most likely a truncated paste or a mangled mail
  // client. It is NOT evidence the token is unused; only `claim_invite` can say that.
  const looksLikeToken = /^[0-9a-f]{64}$/.test(token)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <Stack gap={3}>
        <Badge tone="brand">You&apos;re invited</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Join Fydio</h1>
        <p className="text-ink-muted">
          Fydio is a private, interest-led community for creators and the people whose work
          they trust. Membership starts from an invitation.
        </p>
      </Stack>

      {looksLikeToken ? (
        <Card title="Accept your invitation">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              Continue to create your account and choose a display name, a photo, and five
              hashtags that describe what you make.
            </p>
            <a
              href={`/auth/accept?token=${encodeURIComponent(token)}`}
              className="inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
            >
              Create my account
            </a>
          </Stack>
        </Card>
      ) : (
        <Card title="This link looks incomplete">
          <Stack gap={3}>
            <p className="text-sm text-ink-muted">
              Invitation links contain a long single-use code. This one is missing or has been
              altered &mdash; often the result of a mail client truncating a long URL.
            </p>
            <p className="text-sm text-ink-muted">
              Ask whoever invited you to send a fresh link.
            </p>
          </Stack>
        </Card>
      )}
    </main>
  )
}