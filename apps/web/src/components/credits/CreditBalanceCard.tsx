import { Card, Stack } from '@fydio/ui'

import { CREDIT_COPY, CREDIT_LABEL_LONG, formatCredits, type CreditSummary } from '@fydio/domain'

/**
 * The spendable balance (T05).
 *
 * Available Credits buy submissions; held Credits are earned but still inside
 * their review window and cannot be spent yet. The two figures are rendered
 * side by side so a balance that "jumps" after the window reads as expected
 * rather than as a bug. Reputation never appears here — it is a public
 * quality signal, not money, and this card answers "what can I spend".
 */
export function CreditBalanceCard({
  summary,
}: {
  readonly summary: Pick<CreditSummary, 'available' | 'held' | 'submissionCost'>
}) {
  return (
    <Card title={CREDIT_LABEL_LONG}>
      <Stack gap={2}>
        <p className="text-3xl font-semibold tracking-tight" aria-live="polite">
          {formatCredits(summary.available)}
        </p>
        <div className="flex flex-col gap-1 text-sm text-ink-muted">
          {summary.held > 0 ? (
            <p>
              {formatCredits(summary.held)} held — {CREDIT_COPY.heldExplainer}
            </p>
          ) : null}
          <p>Publishing costs {formatCredits(summary.submissionCost)}.</p>
        </div>
      </Stack>
    </Card>
  )
}
