'use client'

import { useState, type SyntheticEvent } from 'react'

export interface LedgerAuditRow {
  id: string
  user_id: string
  delta: number
  kind: string
  status: string
  note: string | null
  created_at: string
  user_handle?: string
}

export function CreditOpsForm({
  initialUserId,
  recentLedger,
}: {
  initialUserId?: string | undefined
  recentLedger: LedgerAuditRow[]
}) {
  const [op, setOp] = useState<'grant' | 'reverse' | 'cap' | 'ceiling'>('grant')
  const [userId, setUserId] = useState(initialUserId ?? '')
  const [amount, setAmount] = useState('1')
  const [ledgerId, setLedgerId] = useState('')
  const [cap, setCap] = useState('10')
  const [ceiling, setCeiling] = useState('20')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [resultMsg, setResultMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  function fillReverse(row: LedgerAuditRow) {
    setOp('reverse')
    setUserId(row.user_id)
    setLedgerId(row.id)
    setNote(`Admin reversal of row ${row.id.slice(0, 8)}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault()
    setBusy(true)
    setResultMsg(null)

    try {
      let payload: Record<string, unknown>

      if (op === 'grant') {
        payload = {
          op: 'grant',
          userId: userId.trim(),
          amount: parseInt(amount, 10),
          note: note.trim() ? note.trim() : undefined,
        }
      } else if (op === 'reverse') {
        payload = {
          op: 'reverse',
          userId: userId.trim(),
          ledgerId: ledgerId.trim(),
          note: note.trim() ? note.trim() : undefined,
        }
      } else if (op === 'cap') {
        payload = {
          op: 'cap',
          userId: userId.trim(),
          cap: parseInt(cap, 10),
          note: note.trim() ? note.trim() : undefined,
        }
      } else {
        payload = {
          op: 'ceiling',
          userId: userId.trim(),
          max: parseInt(ceiling, 10),
          note: note.trim() ? note.trim() : undefined,
        }
      }

      const res = await fetch('/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const json = (await res.json().catch(() => null)) as {
        balance?: number
        max?: number
        error?: string
      } | null

      if (!res.ok) {
        throw new Error(json?.error ?? 'Credit operation failed')
      }

      const balanceText = json?.balance !== undefined ? ` New balance: ${json.balance} Credits.` : ''
      const maxText = json?.max !== undefined ? ` Future ceiling set to: ${json.max}.` : ''
      setResultMsg({
        type: 'ok',
        text: `Operation succeeded!${balanceText}${maxText}`,
      })
      setNote('')
    } catch (err) {
      setResultMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Operation failed',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Credit Operations Form */}
      <div className="rounded-control border border-border bg-surface p-6">
        <div className="flex items-center gap-2 border-b border-border pb-4 mb-4">
          {(
            [
              { key: 'grant', label: 'Grant Credits', desc: 'Adds Credits for onboarding or good faith' },
              { key: 'reverse', label: 'Reverse Row', desc: 'Claws back a specific ledger row' },
              { key: 'cap', label: 'Clawback Cap', desc: 'Claw back balance to a maximum ceiling' },
              { key: 'ceiling', label: 'Future Ceiling', desc: 'Cap future earning without touching past history' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setOp(item.key)
                setResultMsg(null)
              }}
              className={`rounded-control px-3 py-1.5 text-xs font-medium transition ${
                op === item.key
                  ? 'bg-ink text-surface font-semibold'
                  : 'bg-surface-muted text-ink-muted hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            void handleSubmit(e)
          }}
          className="flex flex-col gap-4"
        >
          <div>
            <label htmlFor="user-id" className="block text-xs font-semibold text-ink mb-1">
              Member UUID
            </label>
            <input
              id="user-id"
              type="text"
              required
              value={userId}
              onChange={(e) => { setUserId(e.target.value); }}
              placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
              className="w-full rounded-control border border-border bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-brand focus:outline-none"
            />
          </div>

          {op === 'grant' && (
            <div>
              <label htmlFor="amount" className="block text-xs font-semibold text-ink mb-1">
                Amount (1–1000 Credits)
              </label>
              <input
                id="amount"
                type="number"
                min="1"
                max="1000"
                required
                value={amount}
                onChange={(e) => { setAmount(e.target.value); }}
                className="w-48 rounded-control border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand focus:outline-none"
              />
            </div>
          )}

          {op === 'reverse' && (
            <div>
              <label htmlFor="ledger-id" className="block text-xs font-semibold text-ink mb-1">
                Ledger Row UUID to Reverse
              </label>
              <input
                id="ledger-id"
                type="text"
                required
                value={ledgerId}
                onChange={(e) => { setLedgerId(e.target.value); }}
                placeholder="Target ledger row ID"
                className="w-full rounded-control border border-border bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-brand focus:outline-none"
              />
            </div>
          )}

          {op === 'cap' && (
            <div>
              <label htmlFor="cap-input" className="block text-xs font-semibold text-ink mb-1">
                Cap Limit (Balance will not exceed this after clawback)
              </label>
              <input
                id="cap-input"
                type="number"
                min="0"
                max="100000"
                required
                value={cap}
                onChange={(e) => { setCap(e.target.value); }}
                className="w-48 rounded-control border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand focus:outline-none"
              />
            </div>
          )}

          {op === 'ceiling' && (
            <div>
              <label htmlFor="ceiling-input" className="block text-xs font-semibold text-ink mb-1">
                Future Earning Ceiling (Earning throttled when balance reaches this)
              </label>
              <input
                id="ceiling-input"
                type="number"
                min="0"
                max="100000"
                required
                value={ceiling}
                onChange={(e) => { setCeiling(e.target.value); }}
                className="w-48 rounded-control border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand focus:outline-none"
              />
            </div>
          )}

          <div>
            <label htmlFor="admin-note" className="block text-xs font-semibold text-ink mb-1">
              Audit Reason / Note
            </label>
            <textarea
              id="admin-note"
              value={note}
              onChange={(e) => { setNote(e.target.value); }}
              placeholder="Context for audit log..."
              className="h-16 w-full rounded-control border border-border bg-surface px-3 py-2 text-xs text-ink focus:border-brand focus:outline-none"
            />
          </div>

          {resultMsg && (
            <div
              className={`rounded-control p-3 text-xs ${
                resultMsg.type === 'ok'
                  ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20'
                  : 'bg-rose-500/10 text-rose-700 border border-rose-500/20'
              }`}
            >
              {resultMsg.text}
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-control bg-brand px-5 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
            >
              {busy ? 'Executing Operation...' : `Execute ${op.toUpperCase()}`}
            </button>
          </div>
        </form>
      </div>

      {/* Recent Ledger Entries for Reference */}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold tracking-wide text-ink uppercase">
          Recent Credit Ledger Transactions
        </h3>
        <div className="overflow-x-auto rounded-control border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Row ID</th>
                <th className="px-3 py-3 font-semibold">User</th>
                <th className="px-3 py-3 font-semibold">Kind</th>
                <th className="px-3 py-3 font-semibold text-right">Delta</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {recentLedger.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-muted">
                    No credit ledger records found.
                  </td>
                </tr>
              ) : (
                recentLedger.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-muted/30">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-ink">
                      {row.id.slice(0, 8)}...
                    </td>
                    <td className="px-3 py-2.5 text-ink">
                      <span className="font-mono text-[11px]">
                        {row.user_handle ? `@${row.user_handle}` : `${row.user_id.slice(0, 8)}...`}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-muted">
                      {row.kind}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right font-medium ${
                        row.delta > 0 ? 'text-brand' : 'text-ink-subtle'
                      }`}
                    >
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                          row.status === 'available'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : row.status === 'held'
                              ? 'bg-amber-500/10 text-amber-600'
                              : row.status === 'spent'
                                ? 'bg-surface-muted text-ink-muted'
                                : 'bg-rose-500/10 text-rose-600'
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-ink-muted whitespace-nowrap">
                      {new Date(row.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {row.status !== 'reversed' && row.delta > 0 && (
                        <button
                          type="button"
                          onClick={() => { fillReverse(row); }}
                          className="rounded-control border border-border px-2 py-0.5 text-[10px] font-medium text-rose-600 hover:bg-surface-muted"
                        >
                          Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
