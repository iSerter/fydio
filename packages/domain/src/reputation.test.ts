import { describe, expect, it } from 'vitest'

import {
  allReputationCopy,
  assertValidRating,
  badgeForReputation,
  formatReputationAverage,
  formatReputationTotal,
  isValidRating,
  parseRatingSummary,
  parseReputation,
  REPUTATION_COPY,
} from './reputation.js'

describe('badge tiers', () => {
  it('maps the T06 thresholds exactly', () => {
    expect(badgeForReputation(0)).toBe('new')
    expect(badgeForReputation(24)).toBe('new')
    expect(badgeForReputation(25)).toBe('contributor')
    expect(badgeForReputation(99)).toBe('contributor')
    expect(badgeForReputation(100)).toBe('trusted')
    expect(badgeForReputation(249)).toBe('trusted')
    expect(badgeForReputation(250)).toBe('mentor')
    expect(badgeForReputation(10_000)).toBe('mentor')
  })

  it('honours operator overrides', () => {
    const thresholds = { contributor: 50, trusted: 200, mentor: 500 }
    expect(badgeForReputation(49, thresholds)).toBe('new')
    expect(badgeForReputation(50, thresholds)).toBe('contributor')
    expect(badgeForReputation(500, thresholds)).toBe('mentor')
  })
})

describe('rating validation', () => {
  it('accepts 1–10 integers only', () => {
    expect(isValidRating(1)).toBe(true)
    expect(isValidRating(10)).toBe(true)
    expect(isValidRating(0)).toBe(false)
    expect(isValidRating(11)).toBe(false)
    expect(isValidRating(7.5)).toBe(false)
    expect(isValidRating('8')).toBe(false)
    expect(() => {
      assertValidRating(0)
    }).toThrow()
    expect(() => {
      assertValidRating(11)
    }).toThrow()
  })
})

describe('reputation parsing', () => {
  const payload = { total: 42, ratedCount: 5, average: 8.4, badge: 'contributor' }

  it('parses the get_reputation shape', () => {
    expect(parseReputation(payload)).toEqual({ kind: 'reputation', ...payload })
  })

  it('accepts a null average for an unrated member', () => {
    expect(
      parseReputation({ total: 0, ratedCount: 0, average: null, badge: 'new' }).average,
    ).toBeNull()
  })

  it('refuses malformed payloads', () => {
    expect(() => parseReputation(null)).toThrow()
    expect(() => parseReputation({ ...payload, badge: 'legend' })).toThrow()
    expect(() => parseReputation({ ...payload, average: 'high' })).toThrow()
  })

  it('parses the get_rating_summary shape with recent rows', () => {
    const summary = parseRatingSummary({
      ...payload,
      recent: [
        {
          feedback_id: '00000000-0000-0000-0000-000000000001',
          entry_id: '00000000-0000-0000-0000-000000000002',
          score: 8,
          created_at: '2026-01-01T00:00:00Z',
          revised_at: null,
        },
      ],
    })
    expect(summary.recent).toHaveLength(1)
    expect(summary.recent[0]?.score).toBe(8)
  })

  it('defaults a missing recent list to empty', () => {
    expect(parseRatingSummary(payload).recent).toEqual([])
  })
})

describe('reputation formatting', () => {
  it('never reads as spendable', () => {
    expect(formatReputationTotal(42)).toBe('42 Reputation')
    expect(formatReputationAverage(null, 0)).toBe('No ratings yet')
    expect(formatReputationAverage(8.4, 5)).toBe('8.40 average from 5 ratings')
    expect(formatReputationAverage(9, 1)).toBe('9.00 average from 1 rating')
  })
})

describe('reputation copy', () => {
  it('frames reputation as helpfulness, never popularity or points', () => {
    expect(REPUTATION_COPY.explainer).toMatch(/cannot be spent or transferred/)
    for (const text of allReputationCopy()) {
      expect(text.toLowerCase()).not.toMatch(/\bpoints?\b|\bpts\b/)
    }
    expect(REPUTATION_COPY.noLeaderboard.toLowerCase()).toContain('no public rankings')
  })
})
