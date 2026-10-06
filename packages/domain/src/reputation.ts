import { MAX_RATING, MIN_RATING, REPUTATION_LABEL } from './constants.js'

/**
 * Feedback Reputation (T06): the quality signal.
 *
 * Credits are spent to submit; Reputation is a lifetime helpfulness total that
 * can never be spent, transferred, or converted. The ledger (`reputation_ledger`)
 * is the source of truth; `ReputationSummary` below is its display-facing shape,
 * parsed from `get_reputation` / `get_rating_summary`.
 */

/** Badge tiers. Thresholds mirror the `app.reputation_badge_thresholds` default. */
export const REPUTATION_BADGES = ['new', 'contributor', 'trusted', 'mentor'] as const

export type ReputationBadge = (typeof REPUTATION_BADGES)[number]

/** Operator-tunable thresholds; the GUC default lives in migration 0017. */
export const REPUTATION_BADGE_THRESHOLDS = {
  contributor: 25,
  trusted: 100,
  mentor: 250,
} as const

/** Badge for a lifetime total. Pure so SQL and TS cannot disagree. */
export function badgeForReputation(
  total: number,
  thresholds: {
    contributor: number
    trusted: number
    mentor: number
  } = REPUTATION_BADGE_THRESHOLDS,
): ReputationBadge {
  if (total >= thresholds.mentor) return 'mentor'
  if (total >= thresholds.trusted) return 'trusted'
  if (total >= thresholds.contributor) return 'contributor'
  return 'new'
}

/**
 * A member's public reputation, as returned by `get_reputation`.
 *
 * `kind: 'reputation'` is the nominal discriminant that makes this
 * structurally incompatible with `CreditBalance` (`kind: 'credits'`) — see
 * `types-separation.ts`. The field names (`total`, `ratedCount`, `average`,
 * `badge`) match the RPC JSON exactly so no mapping layer can drift.
 */
export interface ReputationSummary {
  readonly kind: 'reputation'
  readonly total: number
  readonly ratedCount: number
  readonly average: number | null
  readonly badge: ReputationBadge
}

/** One rated feedback row from `get_rating_summary().recent`. */
export interface RatedFeedbackItem {
  readonly feedback_id: string
  readonly entry_id: string
  readonly score: number
  readonly created_at: string
  readonly revised_at: string | null
}

/** Aggregate plus recent ratings — the `get_rating_summary` shape. */
export interface RatingSummary extends ReputationSummary {
  readonly recent: readonly RatedFeedbackItem[]
}

/** True for a 1–10 integer rating. Mirrors the `rating_range` CHECK. */
export function isValidRating(score: unknown): score is number {
  return (
    typeof score === 'number' &&
    Number.isInteger(score) &&
    score >= MIN_RATING &&
    score <= MAX_RATING
  )
}

/** Throw for an out-of-range rating rather than clamping it. */
export function assertValidRating(score: number): void {
  if (!isValidRating(score)) {
    throw new Error(`Rating must be between ${MIN_RATING} and ${MAX_RATING}`)
  }
}

/** "42 Reputation", "1 Reputation" — never suffixed with a spendable noun. */
export function formatReputationTotal(total: number): string {
  return `${total} ${REPUTATION_LABEL}`
}

/** "4.50 average from 12 ratings" / "No ratings yet". */
export function formatReputationAverage(average: number | null, ratedCount: number): string {
  if (ratedCount === 0 || average === null) return 'No ratings yet'
  return `${average.toFixed(2)} average from ${ratedCount} ${ratedCount === 1 ? 'rating' : 'ratings'}`
}

/** Parse the `get_reputation` payload without trusting it. */
export function parseReputation(value: unknown): ReputationSummary {
  if (typeof value !== 'object' || value === null) {
    throw new Error('That reputation summary is not valid.')
  }
  const record = value as Record<string, unknown>

  const total = record.total
  const ratedCount = record.ratedCount
  if (typeof total !== 'number' || !Number.isInteger(total)) {
    throw new Error('That reputation summary is not valid.')
  }
  if (typeof ratedCount !== 'number' || !Number.isInteger(ratedCount) || ratedCount < 0) {
    throw new Error('That reputation summary is not valid.')
  }

  const average = record.average
  if (average !== null && (typeof average !== 'number' || !Number.isFinite(average))) {
    throw new Error('That reputation summary is not valid.')
  }

  const badge = record.badge
  if (typeof badge !== 'string' || !(REPUTATION_BADGES as readonly string[]).includes(badge)) {
    throw new Error('That reputation summary is not valid.')
  }

  return {
    kind: 'reputation',
    total,
    ratedCount,
    average,
    badge: badge as ReputationBadge,
  }
}

/** Parse the `get_rating_summary` payload (aggregate + recent rows). */
export function parseRatingSummary(value: unknown): RatingSummary {
  const base = parseReputation(value)
  const record = value as Record<string, unknown>

  const recent = Array.isArray(record.recent)
    ? record.recent.map((row): RatedFeedbackItem => {
        if (typeof row !== 'object' || row === null) {
          throw new Error('That rating summary is not valid.')
        }
        const entry = row as Record<string, unknown>
        if (
          typeof entry.feedback_id !== 'string' ||
          typeof entry.entry_id !== 'string' ||
          typeof entry.score !== 'number' ||
          typeof entry.created_at !== 'string'
        ) {
          throw new Error('That rating summary is not valid.')
        }
        if (!isValidRating(entry.score)) {
          throw new Error('That rating summary is not valid.')
        }
        return {
          feedback_id: entry.feedback_id,
          entry_id: entry.entry_id,
          score: entry.score,
          created_at: entry.created_at,
          revised_at: typeof entry.revised_at === 'string' ? entry.revised_at : null,
        }
      })
    : []

  return { ...base, recent }
}

/**
 * Reputation-facing copy. Components render these constants rather than
 * inventing wording, so the helpfulness framing survives future edits.
 */
export const REPUTATION_COPY = {
  explainer:
    'Reputation reflects how useful the community found your feedback. It cannot be spent or transferred.',
  emptyState:
    'No ratings yet. Keep leaving thoughtful feedback and creators will rate how useful it was.',
  badgeNew: 'New — no badge yet. Every rating moves you toward contributor.',
  badgeContributor: 'Contributor — the community finds your feedback useful.',
  badgeTrusted: 'Trusted — creators consistently rate your feedback highly.',
  badgeMentor: 'Mentor — your feedback is among the most useful in the community.',
  noLeaderboard: 'Reputation is personal, not comparative. There are no public rankings in Fydio.',
} as const

/** Every reputation-facing string in one place, for copy-guard scans. */
export function allReputationCopy(): readonly string[] {
  return [
    REPUTATION_COPY.explainer,
    REPUTATION_COPY.emptyState,
    REPUTATION_COPY.badgeNew,
    REPUTATION_COPY.badgeContributor,
    REPUTATION_COPY.badgeTrusted,
    REPUTATION_COPY.badgeMentor,
    REPUTATION_COPY.noLeaderboard,
  ]
}
