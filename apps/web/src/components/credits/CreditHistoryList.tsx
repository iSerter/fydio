import { Card, Stack } from '@fydio/ui'

import type { CreditHistoryRow } from '@fydio/domain'

/**
 * The credit audit trail (T05).
 *
 * Every movement stays visible — including reversed rows, which is how a
 * member can tell a reversal from a deletion. Nothing here is a balance: the
 * card lists signed movements, and the balance card owns the totals.
 */
export function CreditHistoryList({ history }: { readonly history: readonly CreditHistoryRow[] }) {
  if (history.length === 0) {
    return (
      <Card title="History">
        <p className="text-sm text-ink-muted">
          No credit activity yet. Leave feedback on someone&apos;s content to earn your first
          Credit.
        </p>
      </Card>
    )
  }

  return (
    <Card title="History">
      <Stack gap={2}>
        <ul className="flex flex-col gap-2">
          {history.map((row, index) => (
            <li
              // The ledger has stable ids, but the RPC projects a history view
              // without them — position in a 50-row recency list is stable
              // enough for React's key, and inventing an id would be worse.
              key={`${row.created_at}-${index}`}
              className="flex items-baseline justify-between gap-4 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {kindLabel(row.kind)}
                  {statusLabel(row.status) !== null ? (
                    <span className="font-normal text-ink-subtle">
                      {' '}
                      · {statusLabel(row.status)}
                    </span>
                  ) : null}
                </p>
                {row.note !== null && row.note.length > 0 ? (
                  <p className="truncate text-xs text-ink-subtle">{row.note}</p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <p className="font-medium tabular-nums">
                  {row.delta > 0 ? `+${row.delta}` : row.delta}
                </p>
                <p className="text-xs text-ink-subtle">{formatDate(row.created_at)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Stack>
    </Card>
  )
}

/** Display names for ledger kinds. Unknown kinds render raw, never crash. */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'weekly_allowance':
      return 'Weekly allowance'
    case 'feedback_earned':
      return 'Feedback earned'
    case 'submission_spend':
      return 'Submission'
    case 'admin_grant':
      return 'Admin grant'
    case 'admin_reverse':
      return 'Admin reversal'
    case 'hold_reversal':
      return 'Reversed'
    case 'hold_release':
      return 'Released'
    case 'entry_removed_reversal':
      return 'Entry removed'
    default:
      return kind
  }
}

/** Only non-obvious states get a suffix; `available`/`spent` need none. */
function statusLabel(status: string): string | null {
  switch (status) {
    case 'held':
      return 'pending review'
    case 'reversed':
      return 'reversed'
    default:
      return null
  }
}

/** A date in the member's locale, or a dash when absent. Invalid dates render as a dash. */
function formatDate(value: string): string {
  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}
