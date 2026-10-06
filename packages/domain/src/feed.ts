import type { FeedReason } from './constants.js'
import {
  DEFAULT_WEIGHTS,
  explainRank,
  scoreCandidate,
  type RankCandidate,
  type RankingWeights,
} from './ranking.js'

/** What the viewer already has in view, used for the diversity caps. */
export interface ViewerContext {
  viewerId: string
  /** The viewer's profile hashtags, lowercased and without the leading `#`. */
  profileHashtags: readonly string[]
  /**
   * Tags of entries this viewer pressed "more like this" on (T07).
   *
   * The affinity signal is the TAGS, not the entries: pressing it once on a
   * motion-graphics post should lift every other motion-graphics post. Omitting it
   * contributes exactly 0 to every score.
   */
  likedHashtags: readonly string[]
  /** Ids already shown above this candidate, in display order. */
  seenEntryIds: readonly string[]
  /**
   * How many entries each author has already occupied in the results so far.
   *
   * A COUNT, not a set. A `Set<string>` cannot represent "this author already
   * appeared twice", which is precisely the case the cap exists for: with a set, a
   * caller who had seen a creator twice still reports 1, the cap never trips, and
   * the third entry is served undemoted. The counts are what `ranked`'s running
   * counters actually need.
   */
  seenAuthors: ReadonlyMap<string, number>
  /** How many entries each platform has already occupied. Same reasoning. */
  seenPlatforms: ReadonlyMap<string, number>
}

export interface DiversityLimits {
  maxPerCreator: number
  maxPerPlatform: number
}

export const DEFAULT_DIVERSITY: DiversityLimits = {
  maxPerCreator: 2,
  maxPerPlatform: 6,
}

export interface RankedEntry {
  id: string
  score: number
  /** Un-penalised score, so the UI can explain a demotion if asked. */
  baseScore: number
  /** Why this entry is here, for the "why am I seeing this?" affordance. */
  reasons: FeedReason[]
  /** Overlap ratio against the viewer's profile hashtags, in [0, 1]. */
  hashtagOverlap: number
  /** Exponential freshness decay in [0, 1]. */
  freshness: number
  /** The `more like this` affinity term. Zero when the viewer has liked nothing. */
  moreLike: number
  /** True when a diversity cap demoted this entry. */
  demoted: boolean
}

export interface RankOptions {
  weights?: RankingWeights
  diversity?: DiversityLimits
  now?: Date
  halfLifeHours?: number
  /** Entries older than this are dropped entirely. */
  maxAgeHours?: number
}

/**
 * Order candidates for the viewer's feed.
 *
 * Diversity caps are applied *during* selection rather than as a post-filter,
 * because a post-filter would drop entries outright and leave a short feed.
 * Here an over-quota entry is demoted by a multiplier instead, so a thin feed
 * still fills — which matters for a 20–30 member community where caps are easy
 * to hit on any given day.
 *
 * Deterministic: ties break on `createdAt` then `id`, so identical input always
 * produces identical output. A feed that reshuffles on refresh reads as broken.
 *
 * PARITY WITH SQL. This is the reference the `rank_feed` function is diffed against
 * by `apps/web/test/ranking.regression.test.ts`, so both the ordering and the
 * penalty have to match it term for term — including the fact that the cap is a
 * running count in DISPLAY order, which is what `row_number() over (partition by
 * author_id ...)` computes in SQL.
 */
export function rankFeed(
  candidates: readonly RankCandidate[],
  viewer: ViewerContext,
  options: RankOptions = {},
): RankedEntry[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const diversity = options.diversity ?? DEFAULT_DIVERSITY
  const now = options.now ?? new Date()
  const halfLifeHours = options.halfLifeHours ?? 36
  const maxAgeHours = options.maxAgeHours ?? Number.POSITIVE_INFINITY

  const scored = candidates
    // Never show a member their own post, and never re-surface something already seen.
    .filter((candidate) => candidate.authorId !== viewer.viewerId)
    .filter((candidate) => !viewer.seenEntryIds.includes(candidate.id))
    .filter((candidate) => {
      const ageHours = (now.getTime() - candidate.createdAt.getTime()) / 1000 / 60 / 60
      return ageHours <= maxAgeHours
    })
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, viewer.profileHashtags, {
        weights,
        now,
        halfLifeHours,
        likedHashtags: viewer.likedHashtags,
      }),
    }))

  scored.sort((a, b) => {
    if (b.score.score !== a.score.score) return b.score.score - a.score.score

    // Deterministic tie-breaks: newest first, then id as a final arbiter so the
    // result never depends on input array order.
    const timeDelta = b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime()
    if (timeDelta !== 0) return timeDelta

    return a.candidate.id.localeCompare(b.candidate.id)
  })

  const authorCounts = new Map<string, number>()
  const platformCounts = new Map<string, number>()

  // Seeded from what the viewer has already been shown, so caps apply ACROSS pages
  // rather than restarting on every fetch. This is what stops a prolific creator
  // appearing twice on page 1 and twice more at the top of page 2.
  for (const [authorId, count] of viewer.seenAuthors) {
    authorCounts.set(authorId, count)
  }
  for (const [platform, count] of viewer.seenPlatforms) {
    platformCounts.set(platform, count)
  }

  const penalized = scored.map(({ candidate, score }) => {
    const authorCount = authorCounts.get(candidate.authorId) ?? 0
    const platformCount = platformCounts.get(candidate.platform) ?? 0

    const overCreatorCap = authorCount >= diversity.maxPerCreator
    const overPlatformCap = platformCount >= diversity.maxPerPlatform

    let finalScore = score.score
    if (overCreatorCap) finalScore *= weights.diversityPenalty
    if (overPlatformCap) finalScore *= weights.platformPenalty

    authorCounts.set(candidate.authorId, authorCount + 1)
    platformCounts.set(candidate.platform, platformCount + 1)

    return {
      id: candidate.id,
      candidate,
      score: finalScore,
      baseScore: score.score,
      reasons: explainRank(candidate, score.overlap),
      hashtagOverlap: score.overlap,
      freshness: score.freshness,
      moreLike: score.moreLike,
      demoted: overCreatorCap || overPlatformCap,
    }
  })

  // Re-sorted by the PENALISED score.
  //
  // Without this the penalty would be cosmetic: a demoted entry would keep the slot
  // its raw score earned it, so a prolific creator could still fill the first page
  // while the score column quietly claimed otherwise. Re-sorting is what makes the
  // cap observable, and it is why the entry can be demoted without being dropped.
  //
  // The tie-breaks are identical to the ones above and deliberately so: SQL orders
  // by `(final_score desc, published_at desc, id asc)` and the regression test
  // compares ORDER as well as score.
  penalized.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score

    const timeDelta = b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime()
    if (timeDelta !== 0) return timeDelta

    return a.candidate.id.localeCompare(b.candidate.id)
  })

  return penalized.map(({ candidate: _candidate, ...entry }) => entry)
}
