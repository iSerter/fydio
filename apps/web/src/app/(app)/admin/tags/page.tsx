import type { Metadata } from 'next'

import { createServiceClient } from '@fydio/supabase/service'

import { TagsManager, type AdminTagItem } from './TagsManager'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Hashtag Management | Admin | Fydio',
}

export default async function AdminTagsPage() {
  const service = createServiceClient()

  const [tagsRes, usageRes] = await Promise.all([
    service.from('hashtags').select('*').order('created_at', { ascending: false }),
    service.from('content_hashtags').select('hashtag_id'),
  ])

  const usageCounts = new Map<string, number>()
  for (const row of usageRes.data ?? []) {
    usageCounts.set(row.hashtag_id, (usageCounts.get(row.hashtag_id) ?? 0) + 1)
  }

  const initialTags: AdminTagItem[] = (tagsRes.data ?? []).map((t) => ({
    id: t.id,
    slug: t.slug,
    label: t.label,
    is_official: t.is_official,
    usageCount: usageCounts.get(t.id) ?? 0,
    created_at: t.created_at,
  }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Hashtags Management</h2>
        <p className="text-xs text-ink-muted">
          Curate system and community hashtags, designate official tags, and update display labels.
        </p>
      </div>

      <TagsManager initialTags={initialTags} />
    </div>
  )
}
