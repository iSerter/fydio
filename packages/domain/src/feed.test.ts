import { describe, expect, it } from 'vitest'

import { DEFAULT_DIVERSITY, rankFeed } from './feed.js'
import { DEFAULT_WEIGHTS } from './ranking.js'

import { NOW, at, candidate, hoursBefore, viewer } from './test/factories.js'

describe('rankFeed', () => {
  it('never shows the viewer their own entry', () => {
    const result = rankFeed([candidate({ id: 'mine', authorId: 'viewer-1' })], viewer(), {
      now: NOW,
    })

    expect(result).toHaveLength(0)
  })

  it('never re-surfaces an entry the viewer already saw', () => {
    const result = rankFeed([candidate({ id: 'seen' })], viewer({ seenEntryIds: ['seen'] }), {
      now: NOW,
    })

    expect(result).toHaveLength(0)
  })

  it('drops entries older than maxAgeHours', () => {
    const result = rankFeed(
      [
        candidate({ id: 'old', createdAt: hoursBefore(1000) }),
        candidate({ id: 'fresh', createdAt: NOW }),
      ],
      viewer(),
      { now: NOW, maxAgeHours: 720 },
    )

    expect(result.map((entry) => entry.id)).toEqual(['fresh'])
  })

  /**
   * A feed that reshuffles on refresh reads as broken, so ordering must depend
   * only on the candidate data — never on the input array order.
   */
  it('is deterministic for tied scores regardless of input order', () => {
    const tied = [
      candidate({ id: 'b', authorId: 'author-b' }),
      candidate({ id: 'a', authorId: 'author-a' }),
    ]

    const first = rankFeed(tied, viewer(), { now: NOW }).map((entry) => entry.id)
    const second = rankFeed([...tied].reverse(), viewer(), { now: NOW }).map((entry) => entry.id)

    expect(first).toEqual(second)
  })

  /**
   * Diversity is a demotion, not a deletion.
   *
   * Post-filtering would empty a thin feed outright, which matters a lot for a
   * 20–30 member community where caps are easy to hit.
   */
  it('demotes entries past the per-creator cap instead of dropping them', () => {
    const shared = ['design', 'motion', 'typography']
    const result = rankFeed(
      [
        candidate({ id: 'a1', authorId: 'author-x', hashtags: shared }),
        candidate({ id: 'a2', authorId: 'author-x', hashtags: shared }),
        candidate({ id: 'a3', authorId: 'author-x', hashtags: shared, createdAt: hoursBefore(4) }),
      ],
      viewer(),
      { now: NOW, diversity: DEFAULT_DIVERSITY },
    )

    expect(result).toHaveLength(3)
    expect(at(result, 0).demoted).toBe(false)
    expect(at(result, 1).demoted).toBe(false)
    expect(at(result, 2).demoted).toBe(true)
    expect(at(result, 2).score).toBeCloseTo(
      at(result, 2).baseScore * DEFAULT_WEIGHTS.diversityPenalty,
      10,
    )
  })

  it('applies the platform cap independently of the creator cap', () => {
    // Three different creators, all YouTube, with the platform cap set to 1.
    const result = rankFeed(
      [
        candidate({ id: 'p1', authorId: 'author-1', platform: 'youtube' }),
        candidate({
          id: 'p2',
          authorId: 'author-2',
          platform: 'youtube',
          createdAt: hoursBefore(1),
        }),
      ],
      viewer(),
      { now: NOW, diversity: { maxPerCreator: 10, maxPerPlatform: 1 } },
    )

    expect(at(result, 0).demoted).toBe(false)
    expect(at(result, 1).demoted).toBe(true)
  })

  it('carries a reason on every ranked entry', () => {
    const result = rankFeed([candidate()], viewer(), { now: NOW })

    for (const entry of result) {
      expect(entry.reasons.length).toBeGreaterThan(0)
    }
  })

  it('ranks a friend’s matching post above a stranger’s unrelated one', () => {
    const result = rankFeed(
      [
        candidate({ id: 'stranger', hashtags: ['cooking'], createdAt: NOW }),
        candidate({
          id: 'friend',
          hashtags: ['design', 'motion', 'typography'],
          isFriend: true,
          createdAt: hoursBefore(3),
        }),
      ],
      viewer(),
      { now: NOW },
    )

    expect(at(result, 0).id).toBe('friend')
  })
})
