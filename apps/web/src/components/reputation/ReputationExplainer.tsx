import { Card, Stack } from '@fydio/ui'

import { REPUTATION_COPY } from '@fydio/domain'

/**
 * "What is this?" copy (T06).
 *
 * Frames reputation as helpfulness judged only by the recipient — never
 * popularity, never points, never a leaderboard. Static copy rendered from the
 * domain constants, so the wording the tests scan is the wording members read.
 */
export function ReputationExplainer() {
  return (
    <Card title="How Reputation works">
      <Stack gap={2}>
        <p className="text-sm text-ink-muted">{REPUTATION_COPY.explainer}</p>
        <p className="text-sm text-ink-muted">{REPUTATION_COPY.noLeaderboard}</p>
      </Stack>
    </Card>
  )
}
