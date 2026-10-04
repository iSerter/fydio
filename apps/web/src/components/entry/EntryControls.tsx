'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Author-only edit/hide/delete controls (T04). Hide and remove never refund —
 * the credit ledger is untouched.
 */
export function EntryControls({ entryId, hidden }: { readonly entryId: string; readonly hidden: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`/api/entries/${entryId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      if (!response.ok) {
        setMessage(payload?.error ?? 'Those changes could not be saved.')
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Remove this entry? The Credit you spent is not refunded.')) return
    setBusy(true)
    try {
      const response = await fetch(`/api/entries/${entryId}`, { method: 'DELETE' })
      if (!response.ok) {
        setMessage('That entry could not be removed.')
        return
      }
      router.push('/feed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
      <p className="text-sm font-medium">Your entry</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void patch({ hidden: !hidden })
          }}
          className="rounded-control border border-border px-3 py-1.5 text-sm disabled:opacity-60"
        >
          {hidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void remove()
          }}
          className="rounded-control border border-critical/30 px-3 py-1.5 text-sm text-critical disabled:opacity-60"
        >
          Remove
        </button>
      </div>
      {message ? (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      ) : null}
    </div>
  )
}
