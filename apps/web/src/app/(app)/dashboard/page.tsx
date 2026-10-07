import type { Metadata } from 'next'
import Link from 'next/link'

import { Card, Stack } from '@fydio/ui'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Creator Dashboard | Fydio',
}

export default async function CreatorDashboardPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  // 1. Creator's submissions
  const { data: myEntries } = await supabase
    .from('content_entries')
    .select('id, title, published_at, status')
    .eq('author_id', userId)

  const entriesCount = myEntries?.length ?? 0
  const entryIds = (myEntries ?? []).map((e) => e.id)

  let feedbackCount = 0
  let ratedCount = 0
  let avgRating = 0
  let totalImpressions = 0
  let openedImpressions = 0

  if (entryIds.length > 0) {
    // 2. Feedback received on those entries
    const { data: feedbackRows } = await supabase
      .from('feedback')
      .select('id, ratings:feedback_ratings(score)')
      .in('entry_id', entryIds)
      .is('removed_at', null)

    feedbackCount = feedbackRows?.length ?? 0

    let scoreSum = 0
    for (const fb of feedbackRows ?? []) {
      const ratingsRaw = fb.ratings as unknown as { score: number }[] | { score: number } | null
      const r = Array.isArray(ratingsRaw) ? ratingsRaw[0] : ratingsRaw
      if (typeof r?.score === 'number') {
        ratedCount++
        scoreSum += r.score
      }
    }
    avgRating = ratedCount > 0 ? Number((scoreSum / ratedCount).toFixed(1)) : 0

    // 3. Impressions on creator's entries
    const { data: impressions } = await supabase
      .from('feed_impressions')
      .select('opened')
      .in('entry_id', entryIds)

    totalImpressions = impressions?.length ?? 0
    openedImpressions = (impressions ?? []).filter((i) => i.opened).length
  }

  const openRate =
    totalImpressions > 0
      ? Number(((openedImpressions / totalImpressions) * 100).toFixed(1))
      : 0

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Creator Dashboard</h1>
          <p className="text-sm text-ink-muted">
            Insights on your published entries, peer feedback received, and ratings.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/inbox"
            className="rounded-control bg-brand px-4 py-2 text-xs font-medium text-white hover:opacity-90 transition"
          >
            Feedback Inbox
          </Link>
          <Link
            href="/dashboard/feedback"
            className="rounded-control border border-border bg-surface px-4 py-2 text-xs font-medium text-ink hover:bg-surface-muted transition"
          >
            My Feedback Portfolio
          </Link>
        </div>
      </header>

      {/* Metrics grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stack gap={1}>
            <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
              Published Entries
            </span>
            <span className="text-3xl font-bold text-ink">{entriesCount}</span>
            <span className="text-[11px] text-ink-muted">Active community posts</span>
          </Stack>
        </Card>

        <Card>
          <Stack gap={1}>
            <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
              Feedback Received
            </span>
            <span className="text-3xl font-bold text-ink">{feedbackCount}</span>
            <span className="text-[11px] text-ink-muted">
              {ratedCount} of {feedbackCount} rated by you
            </span>
          </Stack>
        </Card>

        <Card>
          <Stack gap={1}>
            <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
              Avg Feedback Rating
            </span>
            <span className="text-3xl font-bold text-ink">
              {avgRating > 0 ? `${avgRating}/10` : '—'}
            </span>
            <span className="text-[11px] text-ink-muted">Usefulness of peer critiques</span>
          </Stack>
        </Card>

        <Card>
          <Stack gap={1}>
            <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
              Feed Open Rate
            </span>
            <span className="text-3xl font-bold text-ink">
              {totalImpressions > 0 ? `${openRate}%` : '—'}
            </span>
            <span className="text-[11px] text-ink-muted">
              {openedImpressions} opens of {totalImpressions} impressions
            </span>
          </Stack>
        </Card>
      </div>

      {/* Overview & explanation */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card title="Feedback & Reputation">
          <p className="text-sm text-ink-muted leading-relaxed">
            When you rate feedback received in your{' '}
            <Link href="/inbox" className="font-semibold text-brand underline">
              inbox
            </Link>
            , that score builds the feedback giver&apos;s <strong>Reputation</strong>.
            Reputation cannot be spent, traded, or bought — it reflects consistent, thoughtful
            peer contributions across the community.
          </p>
        </Card>

        <Card title="Credits & Publishing">
          <p className="text-sm text-ink-muted leading-relaxed">
            Publishing new content costs <strong>Credits</strong>. You earn Credits by writing
            eligible feedback on entries you opened in your feed. A Credit is held for 48 hours
            pending review before it becomes available to fund a new submission.
          </p>
        </Card>
      </div>
    </main>
  )
}
