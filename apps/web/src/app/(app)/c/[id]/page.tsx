import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { EntryCard, type EntryTag } from '@/components/entry/EntryCard'
import { EntryControls } from '@/components/entry/EntryControls'
import { publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'
import { getServerEnv } from '@fydio/env/server'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  return { title: `Entry ${id.slice(0, 8)} | Fydio` }
}

/**
 * Public entry page (T04) at /c/[id].
 *
 * "Public" means visible to every signed-in member when active; the author can
 * always see their own even when hidden. The outbound link always points at the
 * ORIGINAL submitted URL. Placeholders mark the T08 open/click actions and the
 * T09 feedback section.
 */
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

      <p className="text-xs text-ink-subtle">
        Feedback on this entry arrives in a later release. Open and click telemetry arrives with it.
      </p>
    </main>
  )
}
