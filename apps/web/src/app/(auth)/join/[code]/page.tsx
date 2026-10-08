import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

import { checkInviteCodeStatus } from '@/lib/invite-code'

export const metadata: Metadata = {
  title: 'Join Fydio',
  robots: {
    index: false,
    follow: false,
  },
}

export const dynamic = 'force-dynamic'

/**
 * Landing page for a shared invite code (T11 §5.8).
 *
 * Validates the code on the server using the service key so an anonymous visitor
 * knows if the link is live before entering an email address.
 *
 * It does NOT display the remaining count to prevent oracle attacks.
 * It does NOT automatically redeem or redirect.
 */
export default async function JoinCodeLandingPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  const { status } = await checkInviteCodeStatus(code)

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

      {status === 'valid' ? (
        <Card title="Claim your invitation">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              Continue to enter your email address and set up your membership.
            </p>
            <a
              href={`/join/${encodeURIComponent(code)}/join`}
              className="inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
            >
              Continue
            </a>
          </Stack>
        </Card>
      ) : status === 'exhausted' ? (
        <Card title="This link is fully claimed">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              Everyone this link was shared with has already joined.
            </p>
            <a
              href="/login"
              className="inline-flex items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Go to sign in
            </a>
          </Stack>
        </Card>
      ) : status === 'expired' || status === 'revoked' ? (
        <Card title="This link is no longer active">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              That invite link has expired or been revoked by the sender.
            </p>
            <a
              href="/login"
              className="inline-flex items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Go to sign in
            </a>
          </Stack>
        </Card>
      ) : (
        <Card title="This link is not valid">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              Invite links contain a short code. This one is missing or has been altered.
            </p>
            <a
              href="/login"
              className="inline-flex items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Go to sign in
            </a>
          </Stack>
        </Card>
      )}
    </main>
  )
}
