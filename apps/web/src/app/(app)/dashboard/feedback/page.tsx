import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'

import {
  FEEDBACK_COPY,
  FEEDBACK_TAG_LABELS,
  badgeForReputation,
} from '@fydio/domain'

import { RatingStars } from '@/components/feedback/RatingStars'
import { coversBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'My Feedback Portfolio | Fydio',
}

export default async function FeedbackPortfolioPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  // 1. Fetch user's profile reputation
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, display_name, handle, avatar_path, reputation_total, rated_feedback_count, reputation_avg')
    .eq('id', userId)
    .single()

  const reputationTotal = profile?.reputation_total ?? 0
  const ratedCount = profile?.rated_feedback_count ?? 0
  const avgRating = profile?.reputation_avg ?? 0
  const badge = badgeForReputation(reputationTotal)

  // 2. Fetch feedback authored by this member
  const { data: feedbackRows } = await supabase
    .from('feedback')
    .select(`
      id, entry_id, body, tags, image_paths, created_at, edited_at, eligibility,
      entry:content_entries(id, title, platform, thumbnail_path),
      ratings:feedback_ratings(score, created_at)
    `)
    .eq('author_id', userId)
    .is('removed_at', null)
    .order('created_at', { ascending: false })

  const items = (feedbackRows ?? []).map((row) => {
    const entry = row.entry as unknown as {
      id: string
      title: string | null
      platform: string
      thumbnail_path: string | null
    } | null
    const ratingsRaw = row.ratings as unknown as
      | { score: number; created_at: string }[]
      | { score: number; created_at: string }
      | null
    const ratingRow = Array.isArray(ratingsRaw) ? ratingsRaw[0] : ratingsRaw

    return {
      id: row.id,
      entryId: row.entry_id,
      body: row.body,
      tags: row.tags,
      imagePaths: row.image_paths,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      eligibility: row.eligibility,
      score: ratingRow?.score ?? null,
      ratedAt: ratingRow?.created_at ?? null,
      entry: {
        id: entry?.id ?? row.entry_id,
        title: entry?.title ?? `Entry ${row.entry_id.slice(0, 8)}`,
        platform: entry?.platform ?? 'web',
        thumbnailPath: entry?.thumbnail_path ?? null,
      },
    }
  })

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2 border-b border-border pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">My Feedback Portfolio</h1>
          <p className="text-sm text-ink-muted">
            The critiques you have written and the ratings creators gave you.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-control border border-border bg-surface px-4 py-2 text-xs font-medium text-ink hover:bg-surface-muted transition"
          >
            Creator Dashboard
          </Link>
          <Link
            href="/inbox"
            className="rounded-control bg-brand px-4 py-2 text-xs font-medium text-white hover:opacity-90 transition"
          >
            Inbox
          </Link>
        </div>
      </header>

      {/* Reputation summary card */}
      <div className="rounded-control border border-border bg-surface p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-ink">Your Reputation</span>
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand capitalize">
                {badge}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {FEEDBACK_COPY.portfolioNote}
            </p>
          </div>

          <div className="flex items-center gap-6 border-t border-border pt-4 sm:border-0 sm:pt-0">
            <div>
              <span className="text-xs text-ink-subtle uppercase tracking-wider">Total</span>
              <p className="text-2xl font-bold text-ink">{reputationTotal}</p>
            </div>
            <div>
              <span className="text-xs text-ink-subtle uppercase tracking-wider">Rated Notes</span>
              <p className="text-2xl font-bold text-ink">{ratedCount}</p>
            </div>
            <div>
              <span className="text-xs text-ink-subtle uppercase tracking-wider">Average</span>
              <p className="text-2xl font-bold text-ink">
                {ratedCount > 0 ? `${avgRating.toFixed(1)}/10` : '—'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Feedback list */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-ink">Critiques You Left ({items.length})</h2>

        {items.length === 0 ? (
          <div className="rounded-control border border-border bg-surface p-8 text-center">
            <p className="text-sm font-medium text-ink">You haven&apos;t left any feedback yet.</p>
            <p className="mt-1 text-xs text-ink-muted">
              Open entries in your feed to review peers and build your Reputation.
            </p>
            <Link
              href="/feed"
              className="mt-4 inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-xs font-medium text-white hover:opacity-90"
            >
              Browse Feed
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((item) => {
              const coverUrl = item.entry.thumbnailPath
                ? publicStorageUrl(coversBucket(), item.entry.thumbnailPath)
                : null

              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-control border border-border bg-surface p-5 shadow-sm"
                >
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <Link
                      href={`/c/${item.entry.id}`}
                      className="flex items-center gap-3 text-sm font-semibold text-ink hover:text-brand transition"
                    >
                      {coverUrl ? (
                        <Image
                          src={coverUrl}
                          alt=""
                          width={48}
                          height={32}
                          unoptimized
                          className="h-8 w-12 rounded object-cover border border-border"
                        />
                      ) : (
                        <div className="flex h-8 w-12 items-center justify-center rounded border border-border bg-surface-muted text-[10px] text-ink-subtle uppercase">
                          {item.entry.platform}
                        </div>
                      )}
                      <span className="line-clamp-1">{item.entry.title}</span>
                    </Link>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-subtle">
                        {new Date(item.createdAt).toLocaleDateString()}
                      </span>
                      {item.editedAt && (
                        <span className="text-xs text-ink-subtle">(edited)</span>
                      )}
                    </div>
                  </div>

                  <p className="whitespace-pre-wrap text-sm text-ink leading-relaxed">
                    {item.body}
                  </p>

                  {item.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted"
                        >
                          {FEEDBACK_TAG_LABELS[tag] || tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted">Creator Rating:</span>
                      {item.score !== null ? (
                        <div className="flex items-center gap-1.5">
                          <RatingStars score={item.score} />
                          <span className="text-xs font-semibold text-ink">
                            {item.score}/10
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-ink-subtle">Not yet rated</span>
                      )}
                    </div>

                    <div className="text-xs text-ink-subtle">
                      Credit status:{' '}
                      <span className="font-medium text-ink capitalize">
                        {item.eligibility}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
