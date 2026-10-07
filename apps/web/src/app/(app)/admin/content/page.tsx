import type { Metadata } from 'next'

import { createServiceClient } from '@fydio/supabase/service'

import { ContentTable, type AdminContentItem } from './ContentTable'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Content Moderation | Admin | Fydio',
}

export default async function AdminContentPage() {
  const service = createServiceClient()

  const { data: rawEntries } = await service
    .from('content_entries')
    .select(`
      id,
      title,
      canonical_url,
      status,
      published_at,
      author:profiles!author_id(handle, display_name)
    `)
    .order('created_at', { ascending: false })
    .limit(100)

  const initialItems: AdminContentItem[] = (rawEntries ?? []).map((e) => {
    const authorRaw = (Array.isArray(e.author) ? e.author[0] : e.author) as {
      handle?: unknown
      display_name?: unknown
    } | null
    const author =
      authorRaw && typeof authorRaw.handle === 'string'
        ? {
            handle: authorRaw.handle,
            display_name: typeof authorRaw.display_name === 'string' ? authorRaw.display_name : authorRaw.handle,
          }
        : null

    return {
      id: e.id,
      title: e.title ?? 'Untitled entry',
      url: e.canonical_url,
      status: e.status,
      published_at: e.published_at,
      author,
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Content Moderation</h2>
        <p className="text-xs text-ink-muted">
          Manage member submissions. Hide entries from public feeds or remove offending content.
          (Note: Submission spend is non-refundable; compensating credits can be granted under Credit Ops).
        </p>
      </div>

      <ContentTable initialItems={initialItems} />
    </div>
  )
}
