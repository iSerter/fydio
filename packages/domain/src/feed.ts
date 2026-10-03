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
  /** Ids already shown above this candidate, in display order. */
  seenEntryIds: readonly string[]
  /** Author ids already represented in the results so far. */
  seenAuthors: ReadonlySet<string>
  /** Platforms already represented in the results so far. */
  seenPlatforms: ReadonlySet<string>
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
      score: scoreCandidate(candidate, viewer.profileHashtags, { weights, now, halfLifeHours }),
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

  // Seed from what the viewer has already been shown, so caps apply across pages
  // rather than restarting on every fetch.
  for (const authorId of viewer.seenAuthors) {
    authorCounts.set(authorId, (authorCounts.get(authorId) ?? 0) + 1)
  }
  for (const platform of viewer.seenPlatforms) {
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1)
  }

  return scored.map(({ candidate, score }) => {
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
      score: finalScore,
      baseScore: score.score,
      reasons: explainRank(candidate, score.overlap),
      hashtagOverlap: score.overlap,
      freshness: score.freshness,
      demoted: overCreatorCap || overPlatformCap,
    }
  })
}
