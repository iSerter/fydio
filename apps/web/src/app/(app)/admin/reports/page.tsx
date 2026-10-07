import type { Metadata } from 'next'

import { createServiceClient } from '@fydio/supabase/service'

import { ReportsQueue, type ReportItem } from './ReportsQueue'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Moderation Reports | Admin | Fydio',
}

export default async function AdminReportsPage() {
  const service = createServiceClient()

  const { data: rawReports } = await service
    .from('moderation_reports')
    .select(`
      id,
      target_type,
      target_id,
      reason,
      details,
      state,
      created_at,
      resolved_at,
      resolution_note,
      reporter:profiles!reporter_id(handle, display_name)
    `)
    .order('created_at', { ascending: false })
    .limit(100)

  const initialReports: ReportItem[] = (rawReports ?? []).map((r) => {
    const reporterRaw = (Array.isArray(r.reporter) ? r.reporter[0] : r.reporter) as {
      handle?: unknown
      display_name?: unknown
    } | null
    const reporter =
      reporterRaw && typeof reporterRaw.handle === 'string'
        ? {
            handle: reporterRaw.handle,
            display_name: typeof reporterRaw.display_name === 'string' ? reporterRaw.display_name : reporterRaw.handle,
          }
        : null

    return {
      id: r.id,
      target_type: r.target_type,
      target_id: r.target_id,
      reason: r.reason,
      details: r.details,
      state: r.state,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      resolution_note: r.resolution_note,
      reporter,
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Member Reports Queue</h2>
        <p className="text-xs text-ink-muted">
          Review community reports filed against entries, feedback, profiles, and hashtags.
          Resolving a feedback report automatically removes the critique and cascades reversals.
        </p>
      </div>

      <ReportsQueue initialReports={initialReports} />
    </div>
  )
}
