import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { EntryCard, type EntryTag } from '@/components/entry/EntryCard'
import { EntryControls } from '@/components/entry/EntryControls'
import {
  EntryFeedbackSection,
  type FeedbackItemData,
} from '@/components/feedback/EntryFeedbackSection'
import { avatarBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'
import { getServerEnv } from '@fydio/env/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  return { title: `Entry ${id.slice(0, 8)} | Fydio` }
}

export default async function EntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ submitted?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: entry } = await supabase
    .from('content_entries')
    .select(
      'id, author_id, platform, original_url, title, caption_excerpt, thumbnail_source, thumbnail_path, preview_state, creator_note, asks_for_feedback, status',
    )
    .eq('id', id)
    .maybeSingle()

  if (!entry) notFound()
  if (entry.status !== 'active' && entry.author_id !== userId) notFound()

  const isRemoved = entry.status === 'removed'
  const isAuthor = entry.author_id === userId

  const { data: tagRows } = await supabase
    .from('content_hashtags')
    .select('hashtag:hashtags(id, slug)')
    .eq('content_entry_id', id)
    .order('position', { ascending: true })

  const tags: EntryTag[] = (tagRows ?? []).flatMap((row) => {
    const h = row.hashtag as unknown as { id?: string; slug?: string } | null
    return h?.id && h.slug ? [{ id: h.id, slug: h.slug }] : []
  })

  const { data: author } = await supabase
    .from('profiles')
    .select('display_name, handle, avatar_path')
    .eq('id', entry.author_id)
    .maybeSingle()

  const coverUrl = entry.thumbnail_path
    ? publicStorageUrl(getServerEnv().STORAGE_BUCKET_COVERS, entry.thumbnail_path)
    : null

  // Check whether viewer has opened the entry
  const { data: openedRow } = await supabase
    .from('feed_impressions')
    .select('opened')
    .eq('entry_id', id)
    .eq('viewer_id', userId)
    .eq('opened', true)
    .maybeSingle()

  const hasOpened = Boolean(openedRow)

  // Fetch feedback for this entry
  const { data: feedbackRows } = await supabase
    .from('feedback')
    .select(`
      id, entry_id, body, tags, image_paths, created_at, edited_at, eligibility,
      author:profiles!feedback_author_id_fkey(id, display_name, handle, avatar_path, reputation_total),
      ratings:feedback_ratings(score, created_at)
    `)
    .eq('entry_id', id)
    .is('removed_at', null)
    .order('created_at', { ascending: false })

  const feedbackList: FeedbackItemData[] = (feedbackRows ?? []).map((row) => {
    const fbAuthor = row.author as unknown as {
      id: string
      display_name: string
      handle: string
      avatar_path: string | null
      reputation_total: number
    } | null

    const ratingsRaw = row.ratings as unknown as
      | { score: number; created_at: string }[]
      | { score: number; created_at: string }
      | null
    const ratingRow = Array.isArray(ratingsRaw) ? ratingsRaw[0] : ratingsRaw

    return {
      id: row.id,
      entryId: row.entry_id,
      author: {
        id: fbAuthor?.id ?? '',
        displayName: fbAuthor?.display_name ?? 'Member',
        handle: fbAuthor?.handle ?? 'member',
        avatarUrl: fbAuthor?.avatar_path
          ? publicStorageUrl(avatarBucket(), fbAuthor.avatar_path)
          : null,
        reputationTotal: fbAuthor?.reputation_total ?? 0,
      },
      body: row.body,
      tags: row.tags,
      imagePaths: row.image_paths,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      score: ratingRow?.score ?? null,
      ratedAt: ratingRow?.created_at ?? null,
      eligibility: row.eligibility,
    }
  })

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      {query.submitted === '1' && !isRemoved ? (
        <p role="status" className="rounded-control border border-brand/20 bg-brand-soft px-3 py-2 text-sm text-brand">
          Published — one Credit was spent.
        </p>
      ) : null}
      {isRemoved && isAuthor ? (
        <p role="status" className="rounded-control border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
          This entry was removed. It stays in the audit trail but is no longer visible to others.
        </p>
      ) : null}

      {author ? (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">
            {author.display_name} <span className="text-ink-subtle">@{author.handle}</span>
          </span>
        </div>
      ) : null}

      <EntryCard
        entryId={entry.id}
        platform={entry.platform}
        originalUrl={entry.original_url}
        title={entry.title}
        caption={entry.caption_excerpt}
        thumbnailSource={entry.thumbnail_source}
        coverUrl={coverUrl}
        previewState={entry.preview_state}
        hashtags={tags}
        creatorNote={entry.creator_note}
        asksForFeedback={entry.asks_for_feedback}
      />

      {isAuthor && !isRemoved ? <EntryControls entryId={entry.id} hidden={entry.status === 'hidden'} /> : null}

      <EntryFeedbackSection
        entryId={entry.id}
        isAuthor={isAuthor}
        hasOpened={hasOpened}
        currentUserId={userId}
        initialFeedback={feedbackList}
      />
    </main>
  )
}
