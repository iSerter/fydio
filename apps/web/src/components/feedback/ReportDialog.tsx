'use client'

import { useState, type SyntheticEvent } from 'react'

import {
  REPORT_REASONS,
  type ReportTarget,
} from '@fydio/domain'

export interface ReportDialogProps {
  readonly targetType: ReportTarget
  readonly targetId: string
  readonly targetLabel?: string
  readonly triggerLabel?: string
  readonly className?: string
}

export function ReportDialog({
  targetType,
  targetId,
  targetLabel,
  triggerLabel = 'Report',
  className = '',
}: ReportDialogProps) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState(REPORT_REASONS[targetType][0] ?? 'Other')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const reasons = REPORT_REASONS[targetType]

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          targetType,
          targetId,
          reason,
          details: details.trim() || undefined,
        }),
      })

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        error?: string
      } | null

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Could not submit report.')
      }

      setSuccess(true)
      setTimeout(() => {
        setOpen(false)
        setSuccess(false)
        setDetails('')
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit report.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); }}
        className={
          className ||
          'text-xs text-ink-subtle hover:text-red-500 transition-colors inline-flex items-center gap-1'
        }
      >
        <span>⚑</span> {triggerLabel}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-md rounded-control border border-border bg-surface p-6 shadow-xl">
            <h2 id="report-modal-title" className="text-lg font-semibold text-ink">
              Report {targetLabel ?? targetType.replace('_', ' ')}
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              Reports are reviewed by moderators to keep the community safe and constructive.
            </p>

            {success ? (
              <div role="status" className="my-6 rounded-control bg-brand-soft p-4 text-center text-sm font-medium text-brand">
                Thank you. Your report has been submitted for moderation review.
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  void handleSubmit(e)
                }}
                className="mt-4 flex flex-col gap-4"
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="report-reason" className="text-xs font-medium text-ink">
                    Reason
                  </label>
                  <select
                    id="report-reason"
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); }}
                    className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
                  >
                    {reasons.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor="report-details" className="text-xs font-medium text-ink">
                    Additional details (optional)
                  </label>
                  <textarea
                    id="report-details"
                    rows={3}
                    maxLength={2000}
                    value={details}
                    onChange={(e) => { setDetails(e.target.value); }}
                    placeholder="Provide additional context to help moderators understand the issue..."
                    className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
                  />
                  <span className="text-right text-[10px] text-ink-subtle">
                    {details.length} / 2000
                  </span>
                </div>

                {error && <p className="text-xs text-red-500">{error}</p>}

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false)
                      setError(null)
                    }}
                    className="rounded-control border border-border px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-muted"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-control bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {busy ? 'Submitting...' : 'Submit report'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
