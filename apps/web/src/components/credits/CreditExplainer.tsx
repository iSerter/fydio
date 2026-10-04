import { Card, Stack } from '@fydio/ui'

import { CREDIT_COPY } from '@fydio/domain'

/**
 * "How do I earn Credits?" (T05).
 *
 * Static copy rendered from the domain constants, so the wording the
 * copy-guard test scans is the wording members read. The last line states the
 * Credits/Reputation split explicitly — the brief warns the two blur over
 * time, and the dashboard is where a member would first confuse them.
 */
export function CreditExplainer() {
  return (
    <Card title="How Credits work">
      <Stack gap={2}>
        <p className="text-sm text-ink-muted">{CREDIT_COPY.explainer}</p>
        <p className="text-sm text-ink-muted">{CREDIT_COPY.heldExplainer}</p>
        <p className="text-sm text-ink-muted">{CREDIT_COPY.reputationContrast}</p>
      </Stack>
    </Card>
  )
}
