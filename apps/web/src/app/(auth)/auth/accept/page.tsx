import type { Metadata } from 'next'
import { Badge, Card, Stack } from '@fydio/ui'

import { InviteAcceptanceCard } from '@/components/auth/InviteAcceptanceCard'

export const metadata: Metadata = {
  title: 'Accept invitation | Fydio',
}

/** Dynamic: the token arrives in the query string. */
export const dynamic = 'force-dynamic'

/**
 * The redemption page (T03).
 *
 * Reached from `/invite/<token>`, which validates the link's shape and then stops. The
 * claim itself happens in `InviteAcceptanceCard` on mount.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = params.token
  const token = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')

  const valid = /^[0-9a-f]{64}$/.test(token)

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <Stack gap={3}>
        <Badge tone="brand">Welcome</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Set up your membership</h1>
        <p className="text-ink-muted">
          Next you will pick a display name, a photo, and five hashtags describing what you
          make. Those five tags are what decide what shows up in your feed.
        </p>
      </Stack>

      {valid ? (
        <InviteAcceptanceCard token={token} />
      ) : (
        <Card title="This link is incomplete">
          <Stack gap={3}>
            <p className="text-sm text-ink-muted">
              Invitation links contain a long single-use code, and this one is missing or has
              been altered.
            </p>
            <p className="text-sm text-ink-muted">Ask whoever invited you to send a fresh link.</p>
          </Stack>
        </Card>
      )}
    </main>
  )
}