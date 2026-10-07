import { describe, expect, it } from 'vitest'

import {
  FEEDBACK_COPY,
  isWithinFeedbackEditGrace,
  isWithinRatingRevisionWindow,
  meetsQualityGate,
  REPORT_REASONS,
  submitFeedbackSchema,
  submitReportSchema,
} from './feedback.js'

describe('feedback domain logic', () => {
  describe('meetsQualityGate', () => {
    it('requires 40 characters when no image is attached', () => {
      expect(meetsQualityGate('123456789012345678901234567890123456789', 0, 40)).toBe(false)
      expect(meetsQualityGate('1234567890123456789012345678901234567890', 0, 40)).toBe(true)
      expect(
        meetsQualityGate('This critique easily exceeds forty characters of detailed feedback.', 0, 40),
      ).toBe(true)
    })

    it('passes with short text if at least one image is attached', () => {
      expect(meetsQualityGate('See image', 1, 40)).toBe(true)
      expect(meetsQualityGate('Ten chars!', 3, 40)).toBe(true)
    })

    it('trims whitespace before checking length', () => {
      const padded = '   Short   '
      expect(meetsQualityGate(padded, 0, 40)).toBe(false)
    })
  })

  describe('submitFeedbackSchema', () => {
    const validUuid = '11111111-1111-4111-8111-111111111111'

    it('validates proper feedback payload', () => {
      const result = submitFeedbackSchema.safeParse({
        entryId: validUuid,
        body: 'Here is a genuine critique of the video pacing and audio balance.',
        tags: ['hook', 'editing'],
        imagePaths: ['user/image1.webp'],
      })
      expect(result.success).toBe(true)
    })

    it('rejects bodies under 10 characters', () => {
      const result = submitFeedbackSchema.safeParse({
        entryId: validUuid,
        body: 'Too short',
      })
      expect(result.success).toBe(false)
    })

    it('rejects more than 3 images', () => {
      const result = submitFeedbackSchema.safeParse({
        entryId: validUuid,
        body: 'Valid feedback text that is long enough.',
        imagePaths: ['1.webp', '2.webp', '3.webp', '4.webp'],
      })
      expect(result.success).toBe(false)
    })

    it('rejects invalid tags', () => {
      const result = submitFeedbackSchema.safeParse({
        entryId: validUuid,
        body: 'Valid feedback text that is long enough.',
        tags: ['not-a-valid-tag'],
      })
      expect(result.success).toBe(false)
    })
  })

  describe('reporting schemas', () => {
    it('accepts valid reports across all target types', () => {
      for (const targetType of ['content_entry', 'feedback', 'user', 'hashtag'] as const) {
        const reasons = REPORT_REASONS[targetType]
        expect(reasons.length).toBeGreaterThan(0)

        const result = submitReportSchema.safeParse({
          targetType,
          targetId: 'target-123',
          reason: reasons[0],
          details: 'Context for moderation review',
        })
        expect(result.success).toBe(true)
      }
    })

    it('rejects short reasons', () => {
      const result = submitReportSchema.safeParse({
        targetType: 'feedback',
        targetId: 'id-1',
        reason: 'no',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('grace and revision windows', () => {
    it('honors feedback edit grace of 48 hours', () => {
      const now = Date.now()
      const insideGrace = new Date(now - 47 * 3600 * 1000)
      const outsideGrace = new Date(now - 49 * 3600 * 1000)

      expect(isWithinFeedbackEditGrace(insideGrace, 48, now)).toBe(true)
      expect(isWithinFeedbackEditGrace(outsideGrace, 48, now)).toBe(false)
    })

    it('honors rating revision window of 24 hours', () => {
      const now = Date.now()
      const insideWindow = new Date(now - 23 * 3600 * 1000)
      const outsideWindow = new Date(now - 25 * 3600 * 1000)

      expect(isWithinRatingRevisionWindow(insideWindow, 24, now)).toBe(true)
      expect(isWithinRatingRevisionWindow(outsideWindow, 24, now)).toBe(false)
    })
  })

  describe('copy-guard compliance', () => {
    it('ensures no canonical feedback copy string uses "points" or "pts"', () => {
      for (const [key, text] of Object.entries(FEEDBACK_COPY)) {
        expect(
          text.toLowerCase(),
          `Copy string "${key}" contains forbidden word "points"`,
        ).not.toMatch(/\bpoints?\b|\bpts\b/)
      }
    })
  })
})
