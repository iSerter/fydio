import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

import { memberClient, requireUserId } from '@/lib/server'
import { SignOutButton } from './SignOutButton'

export const metadata: Metadata = {
  title: 'Account | Fydio',
}

/** Dynamic: reads the signed-in member's own row and session. */
export const dynamic = 'force-dynamic'

/**
 * Account settings (T03).
 *
 * Session, sign-out, and an overview of what the account holds.
 *
 * WHAT IS DELIBERATELY NOT HERE. No email/password form, no connected accounts, no
 * notification matrix. Fydio never collects credentials and has no third-party sign-in, so
 * "change your password" has no meaning -- there is no password. T09 adds moderation and
 * notification preferences; this page is deliberately the smallest thing that answers "how do I
 * leave, and what does leaving mean".
 *
 * The account overview is an honest count rather than a download button. A full data export is
 * a real feature with real privacy weight (deletion of shared content is not the member's
 * call alone), and a half-built one would be worse than none.
 */
export default async function AccountSettingsPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('handle, display_name, role, reputation_total, rated_feedback_count, created_at')
    .eq('id', userId)
    .maybeSingle()

  const { count: entryCount } = await supabase
    .from('content_entries')
    .select('id', { count: 'exact', head: true })
    .eq('author_id', userId)

  const { count: feedbackCount } = await supabase
    .from('feedback')
    .select('id', { count: 'exact', head: true })
    .eq('author_id', userId)

  const { count: friendCount } = await supabase
    .from('friendships')
    .select('id', { count: 'exact', head: true })
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq('state', 'accepted')

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">Settings</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      </Stack>

      <Card title="Membership">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">Handle</dt>
          <dd className="font-medium">@{profile?.handle ?? '—'}</dd>

          <dt className="text-ink-muted">Role</dt>
          <dd>{profile?.role ?? 'member'}</dd>

          <dt className="text-ink-muted">Joined</dt>
          <dd>{formatDate(profile?.created_at)}</dd>
        </dl>
      </Card>

      <Card title="What you have here">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">Things you have shared</dt>
          <dd>{entryCount ?? 0}</dd>

          <dt className="text-ink-muted">Feedback you have written</dt>
          <dd>{feedbackCount ?? 0}</dd>

          <dt className="text-ink-muted">Confirmed friends</dt>
          <dd>{friendCount ?? 0}</dd>

          <dt className="text-ink-muted">Reputation</dt>
          <dd>{profile?.reputation_total ?? 0}</dd>
        </dl>

        <p className="mt-3 text-xs text-ink-subtle">
          Counts only what is visible to you. Credit balances are private and are never listed
          here.
        </p>
      </Card>

      <Card title="Session">
        <Stack gap={3}>
          <p className="text-sm text-ink-muted">
            You are signed in with a magic link — Fydio never asks for or stores a password.
            Signing out ends this session on this device.
          </p>
          <SignOutButton />
        </Stack>
      </Card>
    </main>
  )
}

/** A date in the member's locale, or a dash when absent. Invalid dates render as a dash. */
function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'

  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString()
}