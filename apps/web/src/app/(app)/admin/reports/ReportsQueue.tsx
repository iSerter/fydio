'use client'

import { useState } from 'react'
import Link from 'next/link'

export interface ReportItem {
  id: string
  target_type: 'content_entry' | 'feedback' | 'user' | 'hashtag'
  target_id: string
  reason: string
  details: string | null
  state: 'open' | 'reviewing' | 'resolved' | 'dismissed'
  created_at: string
  resolved_at: string | null
  resolution_note: string | null
  reporter: {
    handle: string
    display_name: string
  } | null
}

export function ReportsQueue({ initialReports }: { initialReports: ReportItem[] }) {
  const [reports, setReports] = useState<ReportItem[]>(initialReports)
  const [filter, setFilter] = useState<'open' | 'resolved' | 'dismissed' | 'all'>('open')
  const [actingId, setActingId] = useState<string | null>(null)
  const [actionNote, setActionNote] = useState('')
  const [actionState, setActionState] = useState<'resolved' | 'dismissed' | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const filtered = reports.filter((r) => {
    if (filter === 'all') return true
    return r.state === filter
  })

  function openAction(id: string, state: 'resolved' | 'dismissed') {
    setActingId(id)
    setActionState(state)
    setActionNote('')
    setErrorMsg(null)
  }

  function closeAction() {
    setActingId(null)
    setActionState(null)
    setActionNote('')
    setErrorMsg(null)
  }

  async function handleConfirmAction() {
    if (!actingId || !actionState) return
    setBusy(true)
    setErrorMsg(null)

    try {
      const res = await fetch(`/api/admin/reports/${actingId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: actionState,
          note: actionNote.trim() ? actionNote.trim() : undefined,
        }),
      })

      const json = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        throw new Error(json?.error ?? 'Failed to update report')
      }

      setReports((prev) =>
        prev.map((r) =>
          r.id === actingId
            ? {
                ...r,
                state: actionState,
                resolved_at: new Date().toISOString(),
                resolution_note: actionNote.trim() ? actionNote.trim() : null,
              }
            : r,
        ),
      )
      closeAction()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter Tabs */}
      <div className="flex items-center gap-2">
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setFilter(s); }}
            className={`rounded-control px-3 py-1.5 text-xs font-medium capitalize transition ${
              filter === s
                ? 'bg-ink text-surface font-semibold'
                : 'bg-surface-muted text-ink-muted hover:text-ink'
            }`}
          >
            {s} ({reports.filter((r) => (s === 'all' ? true : r.state === s)).length})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-control border border-border bg-surface p-8 text-center text-sm text-ink-muted">
          No reports found matching this filter.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((report) => (
            <div
              key={report.id}
              className="flex flex-col gap-3 rounded-control border border-border bg-surface p-4 transition"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      report.target_type === 'feedback'
                        ? 'bg-amber-500/10 text-amber-600'
                        : report.target_type === 'content_entry'
                          ? 'bg-blue-500/10 text-blue-600'
                          : report.target_type === 'user'
                            ? 'bg-rose-500/10 text-rose-600'
                            : 'bg-emerald-500/10 text-emerald-600'
                    }`}
                  >
                    {report.target_type.replace('_', ' ')}
                  </span>

                  <span
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      report.state === 'open'
                        ? 'bg-rose-500/10 text-rose-600'
                        : report.state === 'resolved'
                          ? 'bg-brand/10 text-brand'
                          : 'bg-ink-muted/10 text-ink-muted'
                    }`}
                  >
                    {report.state}
                  </span>

                  <span className="text-xs text-ink-muted">
                    Reported by{' '}
                    <strong className="text-ink">
                      @{report.reporter?.handle ?? 'unknown'}
                    </strong>
                  </span>
                </div>

                <span className="text-[11px] text-ink-subtle">
                  {new Date(report.created_at).toLocaleString()}
                </span>
              </div>

              {/* Report Reason & Details */}
              <div className="flex flex-col gap-1 text-xs">
                <div>
                  <span className="font-semibold text-ink">Reason: </span>
                  <span className="capitalize text-ink-muted">{report.reason.replace('_', ' ')}</span>
                </div>
                {report.details ? (
                  <p className="rounded bg-surface-muted/60 p-2.5 text-xs text-ink leading-relaxed">
                    {report.details}
                  </p>
                ) : null}
              </div>

              {/* Target Links / Info */}
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <span className="font-medium text-ink-subtle">Target ID:</span>
                <code className="font-mono text-[11px] text-ink bg-surface-muted px-1.5 py-0.5 rounded">
                  {report.target_id}
                </code>
                {report.target_type === 'content_entry' ? (
                  <Link
                    href={`/c/${report.target_id}`}
                    target="_blank"
                    className="font-medium text-brand underline hover:opacity-80"
                  >
                    View Entry ↗
                  </Link>
                ) : null}
              </div>

              {/* Closed Details */}
              {report.state !== 'open' ? (
                <div className="border-t border-border/60 pt-2 text-[11px] text-ink-subtle">
                  {report.state === 'resolved' ? 'Resolved' : 'Dismissed'}{' '}
                  {report.resolved_at ? `on ${new Date(report.resolved_at).toLocaleDateString()}` : ''}
                  {report.resolution_note ? ` — Note: "${report.resolution_note}"` : ''}
                </div>
              ) : null}

              {/* Actions for Open Reports */}
              {report.state === 'open' && (
                <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
                  <button
                    type="button"
                    onClick={() => { openAction(report.id, 'dismissed'); }}
                    className="rounded-control border border-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-muted transition"
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    onClick={() => { openAction(report.id, 'resolved'); }}
                    className="rounded-control bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 transition"
                  >
                    Resolve & Moderate
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Confirmation Modal */}
      {actingId && actionState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-control border border-border bg-surface p-6 shadow-xl flex flex-col gap-4">
            <h3 className="text-base font-bold text-ink">
              {actionState === 'resolved' ? 'Resolve Report' : 'Dismiss Report'}
            </h3>
            <p className="text-xs text-ink-muted leading-relaxed">
              {actionState === 'resolved'
                ? 'Resolving this report confirms a violation. For feedback, it removes the item and claws back any Credits and Reputation earned. For content entries, it hides the entry from the feed.'
                : 'Dismissing this report leaves the target content active. No penalty or reversal is applied.'}
            </p>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="action-note" className="text-xs font-semibold text-ink">
                Admin Note (optional audit record)
              </label>
              <textarea
                id="action-note"
                value={actionNote}
                onChange={(e) => { setActionNote(e.target.value); }}
                placeholder="Reason or moderation context..."
                className="h-20 rounded-control border border-border bg-surface p-2 text-xs text-ink focus:border-brand focus:outline-none"
              />
            </div>

            {errorMsg && <p className="text-xs text-rose-600">{errorMsg}</p>}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeAction}
                disabled={busy}
                className="rounded-control border border-border px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmAction()
                }}
                disabled={busy}
                className={`rounded-control px-4 py-1.5 text-xs font-semibold text-white transition ${
                  actionState === 'resolved' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-ink hover:opacity-90'
                }`}
              >
                {busy ? 'Processing...' : actionState === 'resolved' ? 'Confirm Resolution' : 'Confirm Dismissal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
