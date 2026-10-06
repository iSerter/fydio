import type { CreditBalance, CreditSummary } from './signals.js'
import type { ReputationSummary } from './reputation.js'

/**
 * Credit/Reputation type separation (T05 + T06).
 *
 * The two community signals must never meet: Credits buy submissions,
 * Reputation measures helpfulness and cannot be spent. The `kind`
 * discriminant (`'credits'` vs `'reputation'`) makes a cross-assignment a
 * COMPILE error, and the assertions below turn a future conflation into a
 * build break rather than a silent prop pass.
 *
 * This module is the canonical proof. `signals.test.ts` asserts the runtime
 * half; the `@ts-expect-error` lines here assert the compile-time half.
 */

export type { CreditBalance, ReputationSummary }

/** A credit balance is never a valid reputation summary. */
export function isCreditBalance(value: CreditBalance | ReputationSummary): value is CreditBalance {
  return value.kind === 'credits'
}

/** A reputation summary is never a valid credit balance. */
export function isReputationSummary(
  value: CreditBalance | ReputationSummary,
): value is ReputationSummary {
  return value.kind === 'reputation'
}

declare const _credit: CreditBalance
declare const _reputation: ReputationSummary
declare const _summary: CreditSummary

// @ts-expect-error — a credit balance is not a reputation summary
const _creditIsNotReputation: ReputationSummary = _credit

// @ts-expect-error — a reputation summary is not a credit balance
const _reputationIsNotCredit: CreditBalance = _reputation

// @ts-expect-error — a credit summary (no `kind`) is neither
const _summaryIsNotReputation: ReputationSummary = _summary
