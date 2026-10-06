import { Badge, Card, Stack } from '@fydio/ui'

import {
  formatReputationAverage,
  formatReputationTotal,
  type ReputationSummary,
} from '@fydio/domain'

/**
 * Public reputation display (T06).
 *
 * Total / rated count / average / badge — the `get_reputation` shape. Read-only:
 * rating input lands in T09. The same numbers are shown to the owner and to every
 * other member; reputation is public by product decision (credits are the private half).
 */
export function ReputationCard({ reputation }: { readonly reputation: ReputationSummary }) {
  return (
    <Card title="Reputation">
      <Stack gap={2}>
        <p className="text-3xl font-semibold tracking-tight" aria-live="polite">
          {formatReputationTotal(reputation.total)}
        </p>
        <p className="text-sm text-ink-muted">
          {formatReputationAverage(reputation.average, reputation.ratedCount)}
        </p>
        <div>
          <Badge tone={reputation.badge === 'new' ? 'neutral' : 'brand'}>{reputation.badge}</Badge>
        </div>
      </Stack>
    </Card>
  )
}
