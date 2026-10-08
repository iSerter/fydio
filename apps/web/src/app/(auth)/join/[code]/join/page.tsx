import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

import { checkInviteCodeStatus } from '@/lib/invite-code'
import { JoinCodeForm } from './JoinCodeForm'

export const metadata: Metadata = {
  title: 'Join Fydio',
  robots: {
    index: false,
    follow: false,
  },
}

export const dynamic = 'force-dynamic'

export default async function JoinCodeFormPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  const { status } = await checkInviteCodeStatus(code)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <Stack gap={3}>
        <Badge tone="brand">Join with invite code</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Set up your account</h1>
        <p className="text-ink-muted">
          Enter your email address to join. After joining, you will select five hashtags
          that describe what you make to tune your feed.
        </p>
      </Stack>

      {status === 'valid' ? (
        <JoinCodeForm code={code} />
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
      ) : (
        <Card title="This link is no longer available">
          <Stack gap={4}>
            <p className="text-sm text-ink-muted">
              That invitation link is not valid, or has expired or been revoked.
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
