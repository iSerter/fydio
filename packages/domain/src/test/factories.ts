import type { RankCandidate } from '../ranking.js'
import type { ViewerContext } from '../feed.js'

export const NOW = new Date('2026-03-01T12:00:00.000Z')

/** `n` hours before `NOW`. */
export const hoursBefore = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000)

/**
 * Read one entry from a ranked result by index.
 *
 * `noUncheckedIndexedAccess` makes every index access `| undefined`, and a test
 * that asserts on `result[0]!.id` says nothing useful when `result` is empty.
 * This fails with a useful message instead.
 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index]

  if (item === undefined) {
    throw new Error(`expected at least ${index + 1} item(s), received ${items.length}`)
  }

  return item
}

export function candidate(overrides: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id: 'entry-1',
    authorId: 'author-1',
    platform: 'youtube',
    hashtags: ['design', 'motion'],
    createdAt: hoursBefore(2),
    hasFeedback: false,
    isFriend: false,
    ...overrides,
  }
}

export function viewer(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    viewerId: 'viewer-1',
    profileHashtags: ['design', 'motion', 'typography'],
    // Empty by default so the T07 parity tests opt into the affinity signal
    // explicitly rather than every existing fixture silently scoring against it.
    likedHashtags: [],
    seenEntryIds: [],
    // Counts, not sets: a creator already shown twice has to be distinguishable
    // from one shown once, or the per-creator cap can never trip across pages.
    seenAuthors: new Map(),
    seenPlatforms: new Map(),
    ...overrides,
  }
}
