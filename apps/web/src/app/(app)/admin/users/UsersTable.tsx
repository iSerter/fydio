'use client'

import { useState } from 'react'
import Link from 'next/link'

export interface AdminUserItem {
  id: string
  handle: string
  display_name: string
  role: 'member' | 'admin'
  created_at: string
  availableCredits: number
  heldCredits: number
  reputationAvg: number | null
  ratedCount: number
}

export function UsersTable({ initialUsers }: { initialUsers: AdminUserItem[] }) {
  const [users, setUsers] = useState<AdminUserItem[]>(initialUsers)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const filtered = users.filter((u) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return u.handle.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)
  })

  async function handleToggleRole(user: AdminUserItem) {
    const nextRole = user.role === 'admin' ? 'member' : 'admin'
    const confirmText =
      nextRole === 'admin'
        ? `Grant full administrator privileges to @${user.handle}?`
        : `Demote @${user.handle} back to member?`

    if (!window.confirm(confirmText)) return

    setBusyId(user.id)
    setErrorMsg(null)

    try {
      const res = await fetch(`/api/admin/users/${user.id}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      })

      const json = (await res.json()) as { error?: string } | null
      if (!res.ok) {
        throw new Error(json?.error ?? 'Failed to update role')
      }

      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, role: nextRole } : u)),
      )
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Role update failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Search Input */}
      <div className="flex items-center justify-between gap-4">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          placeholder="Search by handle or display name..."
          className="w-full max-w-sm rounded-control border border-border bg-surface px-3 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
        />
        <span className="text-xs text-ink-muted">
          Showing {filtered.length} of {users.length} members
        </span>
      </div>

      {errorMsg && (
        <div className="rounded-control bg-rose-500/10 p-3 text-xs text-rose-600 border border-rose-500/20">
          {errorMsg}
        </div>
      )}

      {/* Users Table */}
      <div className="overflow-x-auto rounded-control border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Member</th>
              <th className="px-3 py-3 font-semibold">Role</th>
              <th className="px-3 py-3 font-semibold text-right">Available Credits</th>
              <th className="px-3 py-3 font-semibold text-right">Held Credits</th>
              <th className="px-3 py-3 font-semibold text-right">Reputation</th>
              <th className="px-3 py-3 font-semibold">Joined</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-muted">
                  No members matched your search.
                </td>
              </tr>
            ) : (
              filtered.map((user) => (
                <tr key={user.id} className="hover:bg-surface-muted/30">
                  <td className="px-4 py-3 font-medium text-ink">
                    <div className="flex flex-col">
                      <Link
                        href={`/u/${user.handle}`}
                        target="_blank"
                        className="font-bold text-ink hover:text-brand transition"
                      >
                        {user.display_name}
                      </Link>
                      <span className="text-[11px] text-ink-muted">@{user.handle}</span>
                    </div>
                  </td>

                  <td className="px-3 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        user.role === 'admin'
                          ? 'bg-brand/10 text-brand'
                          : 'bg-surface-muted text-ink-muted'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>

                  <td className="px-3 py-3 text-right font-medium text-ink">
                    {user.availableCredits}
                  </td>

                  <td className="px-3 py-3 text-right text-ink-muted">
                    {user.heldCredits > 0 ? `${user.heldCredits} held` : '0'}
                  </td>

                  <td className="px-3 py-3 text-right text-ink">
                    {user.reputationAvg != null ? (
                      <span className="font-semibold text-brand">
                        ★ {user.reputationAvg}{' '}
                        <span className="text-[10px] text-ink-muted font-normal">
                          ({user.ratedCount})
                        </span>
                      </span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </td>

                  <td className="px-3 py-3 text-ink-muted whitespace-nowrap">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>

                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/admin/credits?userId=${user.id}`}
                        className="rounded-control border border-border px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-muted transition"
                      >
                        Credit Ops
                      </Link>

                      <button
                        type="button"
                        onClick={() => { void handleToggleRole(user) }}
                        disabled={busyId === user.id}
                        className={`rounded-control px-2.5 py-1 text-[11px] font-medium transition ${
                          user.role === 'admin'
                            ? 'border border-border text-ink-muted hover:bg-surface-muted'
                            : 'bg-brand text-white hover:opacity-90'
                        }`}
                      >
                        {busyId === user.id
                          ? '...'
                          : user.role === 'admin'
                            ? 'Demote'
                            : 'Make Admin'}
                      </button>
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
