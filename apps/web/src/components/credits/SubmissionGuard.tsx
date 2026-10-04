import { CREDIT_COPY } from '@fydio/domain'

/**
 * The submit affordability guard (T05).
 *
 * Renders nothing when the member can afford the submission; otherwise the
 * explanatory state naming the price and the way to earn it. This is a
 * courtesy, not the enforcement — `create_content_entry` refuses an
 * unaffordable submission at the database layer, so a stale balance or a
 * direct API call cannot bypass the cost.
 */
export function SubmissionGuard({
  available,
  cost,
}: {
  readonly available: number | null
  readonly cost: number
}) {
  if (available === null || available >= cost) return null

  return (
    <p role="alert" className="text-sm text-critical">
      {CREDIT_COPY.guardMessage(cost)}
    </p>
  )
}

/** Whether the submit button should be enabled on affordability grounds alone. */
export function canAfford(available: number | null, cost: number): boolean {
  return available !== null && available >= cost
}
