import {
  CREDIT_LABEL,
  CREDIT_LABEL_LONG,
  REPUTATION_LABEL,
  REPUTATION_LABEL_LONG,
} from './constants.js'

/**
 * Credits and Reputation — display and the rules that keep them apart.
 *
 * The brief is emphatic that these are two deliberately separate signals:
 * Credits are *spent* to submit content, Reputation is a *quality signal* that
 * cannot be spent. Nothing in this module converts one into the other, and the
 * types below are deliberately incompatible so a future refactor cannot
 * accidentally sum them.
 */

/** A spendable Fydio Credit balance. */
export interface CreditBalance {
  readonly kind: 'credits'
  readonly amount: number
}

/** A lifetime Feedback Reputation total. Not spendable, by design. */
export interface ReputationTotal {
  readonly kind: 'reputation'
  readonly amount: number
  readonly ratedFeedbackCount: number
}

/**
 * The two are nominally distinct types with different fields on purpose.
 *
 * Adding them together, or accepting one where the other is expected, is a type
 * error rather than a production bug. T05/T06 add the ledger-side enforcement;
 * this is the front-line of the same defence.
 */
export type CommunitySignal = CreditBalance | ReputationTotal

/** Pluralisation that reads correctly for 0, 1 and many. */
function plural(amount: number, singular: string, pluralForm?: string): string {
  return amount === 1 ? singular : (pluralForm ?? `${singular}s`)
}

export function formatCredits(amount: number): string {
  return `${amount} ${plural(amount, CREDIT_LABEL)}`
}

export function formatCreditsLong(amount: number): string {
  return `${amount} ${plural(amount, CREDIT_LABEL_LONG.replace(/s$/, ''), CREDIT_LABEL_LONG)}`
}

/**
 * Reputation is deliberately *not* suffixed with a spendable-looking noun.
 *
 * The point of the distinct label is that it does not read as a balance.
 */
export function formatReputation(amount: number): string {
  return `${amount} ${REPUTATION_LABEL}`
}

export function formatReputationLong(amount: number): string {
  return `${amount} ${REPUTATION_LABEL_LONG}`
}

/** Can this member submit an entry right now? */
export function canAffordSubmission(balance: CreditBalance, cost: number): boolean {
  return balance.amount >= cost
}

/** Credits pending release from the hold window, shown as "on hold". */
export function formatHeldCredits(amount: number, holdHours: number): string {
  if (amount <= 0) return `No ${CREDIT_LABEL} on hold`

  const window = holdHours >= 48 ? `${Math.round(holdHours / 24)} days` : `${holdHours} hours`

  return `${amount} ${plural(amount, CREDIT_LABEL)} on hold (released within ${window})`
}

/**
 * Group a signal for display, keeping Credits and Reputation in separate buckets.
 *
 * Returns a tuple rather than a merged object so the UI cannot render them in
 * one undifferentiated pile.
 */
export function partitionSignals(signals: readonly CommunitySignal[]): {
  credits: CreditBalance | null
  reputation: ReputationTotal | null
} {
  const credits = signals.find((signal): signal is CreditBalance => signal.kind === 'credits')
  const reputation = signals.find(
    (signal): signal is ReputationTotal => signal.kind === 'reputation',
  )

  return {
    credits: credits ?? { kind: 'credits', amount: 0 },
    reputation: reputation ?? { kind: 'reputation', amount: 0, ratedFeedbackCount: 0 },
  }
}
