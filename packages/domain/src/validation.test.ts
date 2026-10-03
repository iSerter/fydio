import { describe, expect, it } from 'vitest'

import { EXACT_CONTENT_HASHTAGS, MAX_FEEDBACK_IMAGES, MAX_PROFILE_HASHTAGS } from './constants.js'
import {
  contentHashtagsSchema,
  contentSubmissionSchema,
  feedbackSchema,
  profileHashtagsSchema,
  ratingSchema,
} from './validation.js'

describe('profileHashtagsSchema', () => {
  it('accepts exactly five hashtags', () => {
    const result = profileHashtagsSchema.safeParse(['a', 'b', 'c', 'd', 'e'])
    expect(result.success).toBe(true)
  })

  it(`rejects six — ${MAX_PROFILE_HASHTAGS} is a hard maximum`, () => {
    expect(profileHashtagsSchema.safeParse(['a', 'b', 'c', 'd', 'e', 'f']).success).toBe(false)
  })

  it('normalises a leading # and casing', () => {
    const result = profileHashtagsSchema.parse(['#Design', 'MOTION'])
    expect(result).toEqual(['design', 'motion'])
  })

  it('deduplicates', () => {
    expect(profileHashtagsSchema.parse(['design', '#design', 'DESIGN'])).toEqual(['design'])
  })

  it('rejects hashtags with spaces or punctuation', () => {
    expect(profileHashtagsSchema.safeParse(['two words']).success).toBe(false)
    expect(profileHashtagsSchema.safeParse(['emoji✨']).success).toBe(false)
  })
})

describe('contentHashtagsSchema', () => {
  it('requires exactly three', () => {
    expect(contentHashtagsSchema.safeParse(['a', 'b', 'c']).success).toBe(true)
  })

  it('rejects two', () => {
    expect(contentHashtagsSchema.safeParse(['a', 'b']).success).toBe(false)
  })

  it('rejects four', () => {
    expect(contentHashtagsSchema.safeParse(['a', 'b', 'c', 'd']).success).toBe(false)
  })

  it('names the required count in the error message', () => {
    const result = contentHashtagsSchema.safeParse(['a'])
    expect(result.success).toBe(false)

    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(String(EXACT_CONTENT_HASHTAGS))
    }
  })
})

describe('ratingSchema', () => {
  it('accepts the full 1–10 range', () => {
    expect(ratingSchema.safeParse(1).success).toBe(true)
    expect(ratingSchema.safeParse(10).success).toBe(true)
  })

  it('rejects zero, negatives, and anything above ten', () => {
    expect(ratingSchema.safeParse(0).success).toBe(false)
    expect(ratingSchema.safeParse(-1).success).toBe(false)
    expect(ratingSchema.safeParse(11).success).toBe(false)
  })

  it('rejects fractional ratings', () => {
    expect(ratingSchema.safeParse(7.5).success).toBe(false)
  })
})

describe('feedbackSchema', () => {
  const valid = { body: 'The hook lands well but the pacing drags in the middle third.', tags: [] }

  it('accepts valid feedback', () => {
    expect(feedbackSchema.safeParse(valid).success).toBe(true)
  })

  it(`rejects more than ${MAX_FEEDBACK_IMAGES} images`, () => {
    const tooMany = { ...valid, imagePaths: ['a', 'b', 'c', 'd'] }
    expect(feedbackSchema.safeParse(tooMany).success).toBe(false)
  })

  it('rejects a body that is too short to be useful', () => {
    expect(feedbackSchema.safeParse({ ...valid, body: 'nice' }).success).toBe(false)
  })
})

describe('contentSubmissionSchema', () => {
  it('accepts a well-formed submission', () => {
    const result = contentSubmissionSchema.safeParse({
      url: 'https://youtu.be/abc123',
      hashtags: ['#Design', 'motion', 'typography'],
    })

    expect(result.success).toBe(true)
  })

  it('rejects a malformed URL', () => {
    const result = contentSubmissionSchema.safeParse({
      url: 'not-a-url',
      hashtags: ['a', 'b', 'c'],
    })

    expect(result.success).toBe(false)
  })
})
