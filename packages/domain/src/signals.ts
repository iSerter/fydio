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

/**
 * "3 Credits", "1 Credit".
 *
 * The singular is spelled out rather than derived: `CREDIT_LABEL` is already
 * plural ("Credits"), so the generic `${singular}s` fallback would produce
 * "Creditss". Deriving backwards from the plural is how that bug hides.
 */
export function formatCredits(amount: number): string {
  return `${amount} ${plural(amount, 'Credit', CREDIT_LABEL)}`
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

  return `${amount} ${plural(amount, 'Credit', CREDIT_LABEL)} on hold (released within ${window})`
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

/* --- Credit summary (T05) ------------------------------------------------------ */

/**
 * One row of the `get_credit_summary().history` audit trail.
 *
 * `kind`/`status` stay strings rather than narrow unions: the RPC returns the
 * enum values as text and new kinds must render without a client release — an
 * unknown kind is a display string, not a type error.
 */
export interface CreditHistoryRow {
  readonly created_at: string
  readonly delta: number
  readonly kind: string
  readonly status: string
  readonly note: string | null
  readonly entry_url: string | null
  readonly feedback_id: string | null
}

/**
 * A member's credit position, as returned by `get_credit_summary`.
 *
 * This is the RPC-facing shape; `CreditBalance` above is the display-facing
 * one. `toCreditBalance` bridges them so every affordability check and every
 * rendering goes through the same nominal type — and so held credits can
 * never leak into a spendable figure by accident.
 */
export interface CreditSummary {
  readonly available: number
  readonly held: number
  readonly total: number
  readonly submissionCost: number
  readonly history: readonly CreditHistoryRow[]
}

/** The spendable half of a summary, in the nominal display type. */
export function toCreditBalance(summary: Pick<CreditSummary, 'available'>): CreditBalance {
  return { kind: 'credits', amount: summary.available }
}

/**
 * Parse the `get_credit_summary` payload without trusting it.
 *
 * The RPC is ours, but `supabase.rpc` returns `unknown` and a future migration
 * may reshape the JSON — throwing here beats rendering `NaN Credits` or, far
 * worse, treating a malformed payload as affordable.
 */
export function parseCreditSummary(value: unknown): CreditSummary {
  if (typeof value !== 'object' || value === null) {
    throw new Error('That credit summary is not valid.')
  }
  const record = value as Record<string, unknown>

  const integer = (field: string): number => {
    const fieldValue = record[field]
    if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue)) {
      throw new Error('That credit summary is not valid.')
    }
    return fieldValue
  }

  const history = Array.isArray(record.history)
    ? record.history.map((row): CreditHistoryRow => {
        if (typeof row !== 'object' || row === null) {
          throw new Error('That credit summary is not valid.')
        }
        const entry = row as Record<string, unknown>
        if (typeof entry.created_at !== 'string' || typeof entry.delta !== 'number') {
          throw new Error('That credit summary is not valid.')
        }
        return {
          created_at: entry.created_at,
          delta: entry.delta,
          kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
          status: typeof entry.status === 'string' ? entry.status : 'unknown',
          note: typeof entry.note === 'string' ? entry.note : null,
          entry_url: typeof entry.entry_url === 'string' ? entry.entry_url : null,
          feedback_id: typeof entry.feedback_id === 'string' ? entry.feedback_id : null,
        }
      })
    : []

  return {
    available: integer('available'),
    held: integer('held'),
    total: integer('total'),
    submissionCost: integer('submissionCost'),
    history,
  }
}

/**
 * Credit-facing copy. Components render these constants rather than inventing
 * wording, so the Credits-vs-Reputation distinction survives future edits.
 */
export const CREDIT_COPY = {
  explainer:
    'Earn Credits by leaving thoughtful feedback on other members\u2019 content. Every member also receives a small weekly starter allowance.',
  heldExplainer:
    'Newly earned Credits are held for a short review window before they can be spent.',
  guardMessage: (cost: number): string =>
    `You need ${formatCredits(cost)} to publish. Earn ${cost === 1 ? 'it' : 'them'} by leaving feedback on someone\u2019s content.`,
  reputationContrast: `${REPUTATION_LABEL} is public recognition for helpful feedback. It can never be spent.`,
} as const

/**
 * Terms that must never describe Credits. `score` is deliberately ABSENT: it
 * is a legitimate domain term elsewhere (the T07 ranking score, the T06 1–10
 * rating), and banning it would false-positive on unrelated copy.
 */
export const FORBIDDEN_CREDIT_TERMS = /\bpoints?\b|\bpts\b/i

/** True when a credit-facing string keeps the Credits/Reputation split. */
export function isAllowedCreditCopy(text: string): boolean {
  return !FORBIDDEN_CREDIT_TERMS.test(text)
}

/** Every credit-facing string in one place, so the copy-guard test scans all. */
export function allCreditCopy(): readonly string[] {
  return [
    CREDIT_COPY.explainer,
    CREDIT_COPY.heldExplainer,
    CREDIT_COPY.guardMessage(1),
    CREDIT_COPY.reputationContrast,
  ]
}
