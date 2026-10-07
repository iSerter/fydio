'use client'

import { useState } from 'react'

import { deleteDurationHistory } from '@/app/(app)/settings/privacy/actions'

/**
 * "Delete my duration history" (T08).
 *
 * The consent copy promises this, so it is a control rather than a sentence. It is
 * destructive and irreversible, so it asks first — with a confirmation that names
 * exactly what goes, because "delete my data" reading as "delete my feedback" would
 * be a reasonable fear and an inaccurate one.
 *
 * WHAT SURVIVES, SAID OUT LOUD. `delete_own_duration_history` removes
 * `duration_events` and leaves `feed_impressions.opened` alone, because the opened
 * mark is what `submit_feedback` already read: somebody may have written feedback
 * and earned a Credit against it, and quietly invalidating that would be worse than
 * the telemetry being removed. The button says so rather than letting a member
 * discover it later by finding their feedback no longer eligible.
 */
export function ClearActivityButton() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function clear() {
    if (!window.confirm('Delete your duration history? This cannot be undone.')) return

    setBusy(true)
    setMessage(null)

    try {
      const result = await deleteDurationHistory()

      if (!result.ok) {
        setMessage(result.message ?? 'That could not be deleted.')

        return
      }

      setMessage(result.message ?? 'Deleted.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That could not be deleted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void clear()
          }}
          className="rounded-control border border-critical/30 px-3 py-1.5 text-sm text-critical disabled:opacity-60"
        >
          Delete my duration history
        </button>
      </div>

      <p className="text-xs text-ink-subtle">
        Removes the time ranges Fydio has recorded. This cannot be undone. The
        entries you opened stay on this page, because feedback you have already
        left depends on that record.
      </p>

      {message !== null ? (
        <p role="status" className="text-sm text-ink-muted">
          {message}
        </p>
      ) : null}
    </div>
  )
}
