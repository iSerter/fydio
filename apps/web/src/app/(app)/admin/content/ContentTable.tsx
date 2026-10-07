'use client'

import { useState } from 'react'
import Link from 'next/link'

export interface AdminContentItem {
  id: string
  title: string
  url: string
  status: 'active' | 'hidden' | 'removed'
  published_at: string | null
  author: {
    handle: string
    display_name: string
  } | null
}

export function ContentTable({ initialItems }: { initialItems: AdminContentItem[] }) {
  const [items, setItems] = useState<AdminContentItem[]>(initialItems)
  const [filter, setFilter] = useState<'all' | 'active' | 'hidden' | 'removed'>('all')
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const filtered = items.filter((item) => {
    if (filter !== 'all' && item.status !== filter) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      item.title.toLowerCase().includes(q) ||
      (item.author?.handle.toLowerCase().includes(q) ?? false) ||
      (item.author?.display_name.toLowerCase().includes(q) ?? false)
    )
  })

  async function handleSetStatus(item: AdminContentItem, nextStatus: 'active' | 'hidden' | 'removed') {
    const actionVerb = nextStatus === 'active' ? 'restore' : nextStatus
    if (!window.confirm(`Are you sure you want to ${actionVerb} this entry?`)) return

    setBusyId(item.id)
    setErrorMsg(null)

    try {
      const res = await fetch(`/api/admin/content/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      })

      const json = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        throw new Error(json?.error ?? 'Failed to update content entry')
      }

      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: nextStatus } : i)),
      )
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Status Filters */}
        <div className="flex items-center gap-2">
          {(['all', 'active', 'hidden', 'removed'] as const).map((s) => (
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
              {s} ({items.filter((i) => (s === 'all' ? true : i.status === s)).length})
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          placeholder="Filter by title or creator..."
          className="w-full sm:w-64 rounded-control border border-border bg-surface px-3 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
      </div>

      {errorMsg && (
        <div className="rounded-control bg-rose-500/10 p-3 text-xs text-rose-600 border border-rose-500/20">
          {errorMsg}
        </div>
      )}

      {/* Content Table */}
      <div className="overflow-x-auto rounded-control border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Entry Title</th>
              <th className="px-3 py-3 font-semibold">Author</th>
              <th className="px-3 py-3 font-semibold">Status</th>
              <th className="px-3 py-3 font-semibold">Published</th>
              <th className="px-4 py-3 font-semibold text-right">Moderation Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-muted">
                  No content entries match your criteria.
                </td>
              </tr>
            ) : (
              filtered.map((item) => (
                <tr key={item.id} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-3 font-medium text-ink max-w-xs">
                    <div className="flex flex-col gap-0.5">
                      <Link
                        href={`/c/${item.id}`}
                        target="_blank"
                        className="font-bold text-ink hover:text-brand line-clamp-1"
                      >
                        {item.title}
                      </Link>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-ink-subtle hover:underline truncate"
                      >
                        {item.url}
                      </a>
                    </div>
                  </td>

                  <td className="px-3 py-3 text-ink-muted whitespace-nowrap">
                    {item.author ? (
                      <Link
                        href={`/u/${item.author.handle}`}
                        target="_blank"
                        className="hover:text-ink font-medium"
                      >
                        @{item.author.handle}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        item.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : item.status === 'hidden'
                            ? 'bg-amber-500/10 text-amber-600'
                            : 'bg-rose-500/10 text-rose-600'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>

                  <td className="px-3 py-3 text-ink-muted whitespace-nowrap">
                    {item.published_at ? new Date(item.published_at).toLocaleDateString() : 'Draft'}
                  </td>

                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {item.status !== 'active' && (
                        <button
                          type="button"
                          onClick={() => {
                            void handleSetStatus(item, 'active')
                          }}
                          disabled={busyId === item.id}
                          className="rounded-control bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 transition"
                        >
                          Restore
                        </button>
                      )}

                      {item.status !== 'hidden' && (
                        <button
                          type="button"
                          onClick={() => {
                            void handleSetStatus(item, 'hidden')
                          }}
                          disabled={busyId === item.id}
                          className="rounded-control border border-border px-2.5 py-1 text-[11px] font-medium text-amber-600 hover:bg-surface-muted transition"
                        >
                          Hide
                        </button>
                      )}

                      {item.status !== 'removed' && (
                        <button
                          type="button"
                          onClick={() => {
                            void handleSetStatus(item, 'removed')
                          }}
                          disabled={busyId === item.id}
                          className="rounded-control border border-border px-2.5 py-1 text-[11px] font-medium text-rose-600 hover:bg-surface-muted transition"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
