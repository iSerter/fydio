import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'

import {
  FEEDBACK_TAG_LABELS,
  type FeedbackTag,
} from '@fydio/domain'

import { RatingInput } from '@/components/feedback/RatingInput'
import { ReportDialog } from '@/components/feedback/ReportDialog'
import { avatarBucket, coversBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Feedback Inbox | Fydio',
}

interface InboxItem {
  id: string
  body: string
  tags: FeedbackTag[]
  imagePaths: string[]
  createdAt: string
  editedAt: string | null
  eligibility: string
  entry: {
    id: string
    title: string | null
    platform: string
    thumbnailPath: string | null
  }
  author: {
    id: string
    displayName: string
    handle: string
    avatarUrl: string | null
    reputationTotal: number
  }
  rating: {
    score: number
    createdAt: string
  } | null
}

export default async function InboxPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  // First fetch all active entry IDs authored by the creator
  const { data: myEntries } = await supabase
    .from('content_entries')
    .select('id, title, platform, thumbnail_path')
    .eq('author_id', userId)

  const entriesMap = new Map((myEntries ?? []).map((e) => [e.id, e]))
  const entryIds = Array.from(entriesMap.keys())

  let inboxItems: InboxItem[] = []

  if (entryIds.length > 0) {
    const { data: feedbackRows } = await supabase
      .from('feedback')
      .select(`
        id, entry_id, body, tags, image_paths, created_at, edited_at, eligibility,
        author:profiles!feedback_author_id_fkey(id, display_name, handle, avatar_path, reputation_total),
        ratings:feedback_ratings(score, created_at)
      `)
      .in('entry_id', entryIds)
      .is('removed_at', null)
      .order('created_at', { ascending: false })

    inboxItems = (feedbackRows ?? []).map((row) => {
      const entry = entriesMap.get(row.entry_id)
      const ratingsRaw = row.ratings as unknown as
        | { score: number; created_at: string }[]
        | { score: number; created_at: string }
        | null
      const ratingRow = Array.isArray(ratingsRaw) ? ratingsRaw[0] : ratingsRaw

      return {
        id: row.id,
        body: row.body,
        tags: row.tags,
        imagePaths: row.image_paths,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        eligibility: row.eligibility,
        entry: {
          id: entry?.id ?? row.entry_id,
          title: entry?.title ?? null,
          platform: entry?.platform ?? 'web',
          thumbnailPath: entry?.thumbnail_path ?? null,
        },
        author: {
          id: row.author.id,
          displayName: row.author.display_name,
          handle: row.author.handle,
          avatarUrl: row.author.avatar_path
            ? publicStorageUrl(avatarBucket(), row.author.avatar_path)
            : null,
          reputationTotal: row.author.reputation_total,
        },
        rating: ratingRow ? { score: ratingRow.score, createdAt: ratingRow.created_at } : null,
      }
    })
  }

  const unratedCount = inboxItems.filter((i) => i.rating === null).length

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Creator Feedback Inbox</h1>
          <p className="text-sm text-ink-muted">
            Critiques received on your published content. Rate each critique 1–10 to build the author&apos;s Reputation.
          </p>
        </div>

        {unratedCount > 0 && (
          <span className="inline-flex w-fit items-center rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand">
            {unratedCount} unrated
          </span>
        )}
      </header>

      {inboxItems.length === 0 ? (
        <div className="rounded-control border border-border bg-surface p-12 text-center">
          <p className="text-base font-medium text-ink">No feedback in your inbox yet.</p>
          <p className="mt-1 text-xs text-ink-muted">
            When members open your posts in the feed and submit critiques, they will appear here.
          </p>
          <Link
            href="/feed"
            className="mt-4 inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-xs font-medium text-white hover:opacity-90"
          >
            Explore Feed
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {inboxItems.map((item) => {
            const coverUrl = item.entry.thumbnailPath
              ? publicStorageUrl(coversBucket(), item.entry.thumbnailPath)
              : null

            return (
              <div
                key={item.id}
                className="flex flex-col gap-4 rounded-control border border-border bg-surface p-5 shadow-sm transition hover:border-ink-subtle"
              >
                {/* Entry header */}
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
                    <span className="line-clamp-1">
                      {item.entry.title ?? `Entry ${item.entry.id.slice(0, 8)}`}
                    </span>
                  </Link>

                  <ReportDialog
                    targetType="feedback"
                    targetId={item.id}
                    targetLabel={`feedback from @${item.author.handle}`}
                  />
                </div>

                {/* Author & content */}
                <div className="flex items-start gap-3">
                  {item.author.avatarUrl ? (
                    <Image
                      src={item.author.avatarUrl}
                      alt=""
                      width={36}
                      height={36}
                      unoptimized
                      className="h-9 w-9 rounded-full border border-border object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-muted text-xs font-semibold text-ink">
                      {item.author.displayName.slice(0, 1).toUpperCase()}
                    </div>
                  )}

                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">
                        {item.author.displayName}
                      </span>
                      <span className="text-xs text-ink-subtle">@{item.author.handle}</span>
                      <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-subtle">
                        Reputation: {item.author.reputationTotal}
                      </span>
                    </div>

                    <p className="mt-2 whitespace-pre-wrap text-sm text-ink leading-relaxed">
                      {item.body}
                    </p>

                    {item.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
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

                    {item.imagePaths.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.imagePaths.map((p, idx) => (
                          <a
                            key={p}
                            href={`/storage/v1/object/public/feedback-images/${encodeURIComponent(p)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="relative h-16 w-16 overflow-hidden rounded-control border border-border bg-surface-muted hover:opacity-90"
                          >
                            <Image
                              src={`/storage/v1/object/public/feedback-images/${encodeURIComponent(p)}`}
                              alt={`Attachment ${idx + 1}`}
                              fill
                              unoptimized
                              className="object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Credit note (informational) */}
                    <div className="mt-3 text-[11px] text-ink-subtle">
                      Credit status:{' '}
                      <span className="font-medium text-ink-muted capitalize">
                        {item.eligibility}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Rating input area */}
                <div className="mt-2 border-t border-border pt-3">
                  <RatingInput
                    feedbackId={item.id}
                    initialScore={item.rating?.score ?? null}
                    ratedAt={item.rating?.createdAt ?? null}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
