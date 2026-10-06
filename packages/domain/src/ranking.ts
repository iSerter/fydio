import type { FeedReason } from './constants.js'

/**
 * Weights for the ranking formula.
 *
 * These defaults mirror the `FEED_*` environment tunables in `packages/env`.
 * They are passed in rather than imported so this module stays free of any
 * runtime dependency and can be unit-tested against arbitrary weights — which is
 * the whole point of having a reference implementation the SQL can be diffed
 * against.
 */
export interface RankingWeights {
  /** Added when the author is a confirmed friend of the viewer. */
  friendBoost: number
  /** Multiplier on the shared-hashtag overlap ratio. */
  hashtagWeight: number
  /** Added when the author has no feedback yet. */
  feedbackNeedBoost: number
  /**
   * Multiplier on the overlap against the "more like this" tag pool.
   *
   * Added in T07, when the tuning controls shipped. It is a separate term from
   * `hashtagWeight` on purpose: a profile hashtag is an ambient interest the member
   * set once, while a "more like this" press is a deliberate act. They should not be
   * able to cancel out or be retuned as one knob.
   */
  moreLikeBoost: number
  /** Multiplier on the freshness decay factor. */
  freshnessWeight: number
  /** Multiplier applied once a creator's cap is exceeded. */
  diversityPenalty: number
  /** Multiplier applied once a platform's cap is exceeded. */
  platformPenalty: number
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  friendBoost: 0.35,
  hashtagWeight: 1.0,
  feedbackNeedBoost: 0.15,
  moreLikeBoost: 0.1,
  freshnessWeight: 1.0,
  diversityPenalty: 0.5,
  platformPenalty: 0.75,
}

/** A candidate entry, as the ranker needs to see it. */
export interface RankCandidate {
  id: string
  authorId: string
  platform: string
  /** Hashtags on the entry, lowercased and without the leading `#`. */
  hashtags: readonly string[]
  /** Creation time of the entry. */
  createdAt: Date
  /** Whether the author has received any feedback on this entry. */
  hasFeedback: boolean
  /** Whether the viewer and the author are confirmed friends. */
  isFriend: boolean
}

export const HOURS_PER_MS = 1000 * 60 * 60

/**
 * Exponential freshness decay: `2 ** (-age / halfLife)`.
 *
 * Exponential rather than linear because it gives a smooth, monotonic curve with
 * no cliff at the half-life, and `2 ** (-1) === 0.5` makes "half-life" mean what
 * it says. At age 0 the factor is 1; at twice the half-life it is 0.25.
 *
 * Clamped to [0, 1] so a clock skew that puts an entry slightly in the future
 * cannot produce a score above the maximum.
 */
export function freshnessDecay(ageHours: number, halfLifeHours: number): number {
  if (!Number.isFinite(ageHours) || ageHours <= 0) return 1
  if (halfLifeHours <= 0) return 1

  const decay = Math.pow(2, -ageHours / halfLifeHours)

  return Math.min(1, Math.max(0, decay))
}

/**
 * Fraction of the viewer's profile hashtags that appear on the entry, in [0, 1].
 *
 * Divided by the size of the *viewer's* profile, not the intersection, so a
 * broad entry cannot beat a precise one purely by carrying more hashtags.
 */
export function hashtagOverlap(
  entryHashtags: readonly string[],
  profileHashtags: readonly string[],
): number {
  if (profileHashtags.length === 0) return 0

  const entry = new Set(entryHashtags.map((tag) => tag.toLowerCase()))
  const matched = profileHashtags.filter((tag) => entry.has(tag.toLowerCase())).length

  return matched / profileHashtags.length
}

/** The components of a candidate's score, for testing and UI explanation. */
export interface CandidateScore {
  score: number
  relevance: number
  friendship: number
  feedbackNeed: number
  /** The `more like this` affinity term. Zero when the viewer has liked nothing. */
  moreLike: number
  freshness: number
  overlap: number
  /** Overlap against the liked-tag pool, before the `moreLikeBoost` multiplier. */
  likedOverlap: number
}

/**
 * The raw score for a candidate, before diversity is applied.
 *
 * Deliberately isolated from feed assembly so T07 can assert this formula on its
 * own against the SQL implementation — one expression, easy to diff.
 *
 *   score = (overlap * hashtagWeight * freshnessWeight)
 *         + friendship
 *         + feedbackNeed
 *         + (likedOverlap * moreLikeBoost)
 *         + freshness
 *
 * The additive form keeps each signal independently tunable and lets a member
 * with no shared hashtags still receive a ranked feed rather than an empty one.
 *
 * `likedHashtags` defaults to empty, which contributes exactly 0 — so a caller
 * that knows nothing about the T07 tuning controls produces the same score it did
 * before they existed, and the SQL's `liked_tags` array coalescing to `'{}'`
 * mirrors that default rather than special-casing it.
 */
export function scoreCandidate(
  candidate: RankCandidate,
  profileHashtags: readonly string[],
  options: {
    weights?: RankingWeights
    now?: Date
    halfLifeHours?: number
    /** Tags of entries this viewer pressed "more like this" on. */
    likedHashtags?: readonly string[]
  } = {},
): CandidateScore {
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const now = options.now ?? new Date()
  const halfLifeHours = options.halfLifeHours ?? 36

  const ageHours = (now.getTime() - candidate.createdAt.getTime()) / HOURS_PER_MS
  const freshness = freshnessDecay(ageHours, halfLifeHours)
  const overlap = hashtagOverlap(candidate.hashtags, profileHashtags)
  const likedOverlap = hashtagOverlap(candidate.hashtags, options.likedHashtags ?? [])

  const relevance = overlap * weights.hashtagWeight
  const friendship = candidate.isFriend ? weights.friendBoost : 0
  const feedbackNeed = candidate.hasFeedback ? 0 : weights.feedbackNeedBoost
  const moreLike = likedOverlap * weights.moreLikeBoost

  const score =
    relevance * weights.freshnessWeight +
    friendship +
    feedbackNeed +
    moreLike +
    freshness

  return {
    score,
    relevance,
    friendship,
    feedbackNeed,
    moreLike,
    freshness,
    overlap,
    likedOverlap,
  }
}

/**
 * Why an entry is in the feed.
 *
 * Ordered strongest-signal-first so the UI can show the most convincing reason in
 * the primary slot. An entry with no reason would be a bug in the caller, not a
 * user-facing state, so `fresh` always closes the list as the baseline.
 */
export function explainRank(candidate: RankCandidate, overlap: number): FeedReason[] {
  const reasons: FeedReason[] = []

  if (candidate.isFriend) reasons.push('friend')
  if (overlap > 0) reasons.push('shared_hashtag')
  if (!candidate.hasFeedback) reasons.push('new_creator')

  if (reasons.length === 0) reasons.push('fresh')

  return reasons
}
