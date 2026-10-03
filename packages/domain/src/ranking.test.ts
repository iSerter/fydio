import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WEIGHTS,
  explainRank,
  freshnessDecay,
  hashtagOverlap,
  scoreCandidate,
} from './ranking.js'

import { NOW, candidate, hoursBefore } from './test/factories.js'

describe('freshnessDecay', () => {
  it('halves at exactly one half-life', () => {
    expect(freshnessDecay(36, 36)).toBeCloseTo(0.5, 10)
  })

  it('quarters at two half-lives', () => {
    expect(freshnessDecay(72, 36)).toBeCloseTo(0.25, 10)
  })

  it('returns 1 for a brand-new entry', () => {
    expect(freshnessDecay(0, 36)).toBe(1)
  })

  it('clamps a negative age to 1 rather than exceeding it', () => {
    // Clock skew must not produce a score above the maximum.
    expect(freshnessDecay(-5, 36)).toBe(1)
  })

  it('decays monotonically with age', () => {
    const samples = [0, 12, 36, 72, 168].map((age) => freshnessDecay(age, 36))

    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1]
      const current = samples[i]

      // `noUncheckedIndexedAccess` makes these `number | undefined`; the assertions
      // are about ordering, so compare explicitly rather than asserting.
      expect(current).toBeDefined()
      expect(previous).toBeDefined()

      if (current !== undefined && previous !== undefined) {
        expect(current).toBeLessThan(previous)
      }
    }
  })

  it('stays within [0, 1] for extreme ages', () => {
    const decayed = freshnessDecay(100_000, 36)

    expect(decayed).toBeGreaterThanOrEqual(0)
    expect(decayed).toBeLessThanOrEqual(1)
  })
})

describe('hashtagOverlap', () => {
  it('divides by the viewer profile size, not the intersection', () => {
    // 2 of 3 profile hashtags match.
    expect(hashtagOverlap(['design', 'motion'], ['design', 'motion', 'typography'])).toBeCloseTo(
      2 / 3,
      10,
    )
  })

  it('returns 0 when the viewer has no hashtags', () => {
    expect(hashtagOverlap(['design'], [])).toBe(0)
  })

  it('returns 0 when nothing matches', () => {
    expect(hashtagOverlap(['cooking'], ['design', 'motion'])).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(hashtagOverlap(['Design', 'MOTION'], ['design', 'motion'])).toBe(1)
  })

  it('cannot exceed 1 even if the entry repeats a tag', () => {
    expect(hashtagOverlap(['design', 'design', 'design'], ['design'])).toBe(1)
  })
})

describe('scoreCandidate', () => {
  const profile = ['design', 'motion', 'typography']

  it('adds the friend boost only for a confirmed friend', () => {
    const stranger = scoreCandidate(candidate(), profile, { now: NOW })
    const friend = scoreCandidate(candidate({ isFriend: true }), profile, { now: NOW })

    expect(friend.friendship).toBe(DEFAULT_WEIGHTS.friendBoost)
    expect(stranger.friendship).toBe(0)
    expect(friend.score).toBeCloseTo(stranger.score + DEFAULT_WEIGHTS.friendBoost, 10)
  })

  it('adds the feedback-need boost only when the entry has no feedback', () => {
    const needed = scoreCandidate(candidate({ hasFeedback: false }), profile, { now: NOW })
    const satisfied = scoreCandidate(candidate({ hasFeedback: true }), profile, { now: NOW })

    expect(needed.feedbackNeed).toBe(DEFAULT_WEIGHTS.feedbackNeedBoost)
    expect(satisfied.feedbackNeed).toBe(0)
  })

  it('scores a matching, fresh entry above an unrelated, stale one', () => {
    const strong = scoreCandidate(
      candidate({ hashtags: ['design', 'motion', 'typography'], createdAt: NOW }),
      profile,
      { now: NOW },
    )
    const weak = scoreCandidate(
      candidate({ hashtags: ['cooking'], createdAt: hoursBefore(240) }),
      profile,
      {
        now: NOW,
      },
    )

    expect(strong.score).toBeGreaterThan(weak.score)
  })

  /**
   * Pins the formula term by term.
   *
   * T07 mirrors this in SQL; if the weights or the shape of the sum change, this
   * test is where the divergence has to surface first.
   */
  it('matches the documented formula term by term', () => {
    const score = scoreCandidate(
      candidate({ hashtags: ['design', 'motion'], isFriend: true, hasFeedback: false }),
      profile,
      { now: NOW },
    )

    const expected =
      (2 / 3) * DEFAULT_WEIGHTS.hashtagWeight * DEFAULT_WEIGHTS.freshnessWeight +
      DEFAULT_WEIGHTS.friendBoost +
      DEFAULT_WEIGHTS.feedbackNeedBoost +
      score.freshness

    expect(score.score).toBeCloseTo(expected, 10)
  })
})

describe('explainRank', () => {
  it('lists friend first, then shared hashtag, then new creator', () => {
    const reasons = explainRank(
      candidate({ isFriend: true, hashtags: ['design'], hasFeedback: false }),
      1 / 3,
    )

    expect(reasons).toEqual(['friend', 'shared_hashtag', 'new_creator'])
  })

  it('always gives at least one reason', () => {
    const reasons = explainRank(candidate({ isFriend: false, hasFeedback: true }), 0)

    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons).toContain('fresh')
  })
})
