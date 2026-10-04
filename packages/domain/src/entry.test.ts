import { describe, expect, it } from 'vitest'

import { canonicalizeUrl } from './canonicalize.js'
import {
  MAX_COVER_UPLOAD_BYTES,
  MAX_CREATOR_NOTE_CHARS,
  MAX_ENTRY_CAPTION_CHARS,
  MAX_ENTRY_TITLE_CHARS,
} from './constants.js'
import {
  describeCoverRejection,
  detectSubmission,
  editEntrySchema,
  isAcceptableCover,
  sanitizePreviewText,
  submitEntrySchema,
} from './entry.js'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const ID_D = '44444444-4444-4444-8444-444444444444'

describe('detectSubmission valid platforms', () => {
  const valid: [string, string][] = [
    ['https://www.instagram.com/p/AbC123/', 'instagram'],
    ['https://instagram.com/reel/AbC123/', 'instagram'],
    ['https://m.instagram.com/reels/AbC123/', 'instagram'],
    ['https://instagr.am/p/AbC123/', 'instagram'],
    ['https://instagram.com/tv/AbC123/', 'instagram'],
    ['https://www.tiktok.com/@user/video/7234567890123456789', 'tiktok'],
    ['https://tiktok.com/@user.name-1/video/7234567890123456789', 'tiktok'],
    ['https://www.tiktok.com/t/ZT8AbC1234/', 'tiktok'],
    ['https://vm.tiktok.com/ZM2AbC12/', 'tiktok'],
    ['https://vt.tiktok.com/ZS8XyZ12/', 'tiktok'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', 'youtube'],
    ['https://m.youtube.com/live/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'youtube'],
    ['https://x.com/someuser/status/1234567890123456789', 'x'],
    ['https://www.x.com/someuser/status/1234567890123456789', 'x'],
    ['https://mobile.x.com/some.user-name/status/123', 'x'],
    ['https://twitter.com/someuser/status/1234567890123456789', 'x'],
    ['https://www.twitter.com/someuser/status/123', 'x'],
    ['https://mobile.twitter.com/someuser/status/123', 'x'],
  ]
  for (const [url, platform] of valid) {
    it(`accepts ${url}`, () => {
      const result = detectSubmission(url)
      expect(result?.platform).toBe(platform)
      expect(result?.canonicalUrl).toBe(canonicalizeUrl(url.trim()))
    })
  }
})

describe('detectSubmission adversarial hosts', () => {
  const bad = [
    'https://evil-instagram.com/p/AbC123/',
    'https://notinstagram.com/p/AbC123/',
    'https://instagram.com.evil.example/p/AbC123/',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://x.com.evil.example/user/status/123',
    'https://eviltiktok.com/@user/video/123',
    'https://tiktok.com.evil.example/@user/video/123',
    'https://fakeyoutu.be/dQw4w9WgXcQ',
  ]
  for (const url of bad) {
    it(`rejects ${url}`, () => {
      expect(detectSubmission(url)).toBeNull()
    })
  }
})

describe('detectSubmission no-post-path rejections', () => {
  const bad = [
    'https://instagram.com/',
    'https://www.instagram.com/someuser/',
    'https://www.tiktok.com/@user',
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/explore',
    'https://x.com/home',
    'https://x.com/someuser',
  ]
  for (const url of bad) {
    it(`rejects ${url}`, () => {
      expect(detectSubmission(url)).toBeNull()
    })
  }
})

describe('detectSubmission scheme rejections', () => {
  const bad = [
    'http://www.instagram.com/p/AbC123/',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'ftp://www.youtube.com/watch?v=abc',
    'instagram.com/p/AbC123/',
    '',
    '   ',
    'not a url at all',
  ]
  for (const url of bad) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(detectSubmission(url)).toBeNull()
    })
  }
})

describe('detectSubmission canonicalization', () => {
  it('strips tracking params and is idempotent', () => {
    const first = detectSubmission('https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=share&fbclid=abc')
    expect(first).not.toBeNull()
    expect(first?.canonicalUrl).not.toContain('utm_source')
    expect(first?.canonicalUrl).not.toContain('fbclid')
    if (first) expect(canonicalizeUrl(first.canonicalUrl)).toBe(first.canonicalUrl)
  })

  it('trims surrounding whitespace', () => {
    const result = detectSubmission('  https://youtu.be/dQw4w9WgXcQ  ')
    expect(result?.platform).toBe('youtube')
  })
})

describe('submitEntrySchema boundaries', () => {
  it('accepts a valid entry', () => {
    const result = submitEntrySchema.safeParse({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      hashtagIds: [ID_A, ID_B, ID_C],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a 1001-char creator note', () => {
    const result = submitEntrySchema.safeParse({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      hashtagIds: [ID_A, ID_B, ID_C],
      creatorNote: 'x'.repeat(MAX_CREATOR_NOTE_CHARS + 1),
    })
    expect(result.success).toBe(false)
  })

  it('accepts a 1000-char creator note', () => {
    const result = submitEntrySchema.safeParse({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      hashtagIds: [ID_A, ID_B, ID_C],
      creatorNote: 'x'.repeat(MAX_CREATOR_NOTE_CHARS),
    })
    expect(result.success).toBe(true)
  })

  it('rejects 2 hashtags', () => {
    expect(
      submitEntrySchema.safeParse({ url: 'https://youtu.be/dQw4w9WgXcQ', hashtagIds: [ID_A, ID_B] })
        .success,
    ).toBe(false)
  })

  it('rejects 4 hashtags', () => {
    expect(
      submitEntrySchema.safeParse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        hashtagIds: [ID_A, ID_B, ID_C, ID_D],
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate hashtag ids', () => {
    expect(
      submitEntrySchema.safeParse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        hashtagIds: [ID_A, ID_A, ID_B],
      }).success,
    ).toBe(false)
  })

  it('rejects non-uuid hashtag ids', () => {
    expect(
      submitEntrySchema.safeParse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        hashtagIds: [ID_A, ID_B, 'not-a-uuid'],
      }).success,
    ).toBe(false)
  })

  it('rejects an overlong title', () => {
    expect(
      submitEntrySchema.safeParse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        hashtagIds: [ID_A, ID_B, ID_C],
        title: 'x'.repeat(MAX_ENTRY_TITLE_CHARS + 1),
      }).success,
    ).toBe(false)
  })

  it('rejects an overlong caption', () => {
    expect(
      submitEntrySchema.safeParse({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        hashtagIds: [ID_A, ID_B, ID_C],
        caption: 'x'.repeat(MAX_ENTRY_CAPTION_CHARS + 1),
      }).success,
    ).toBe(false)
  })
})

describe('editEntrySchema', () => {
  it('accepts empty partial', () => {
    expect(editEntrySchema.safeParse({}).success).toBe(true)
  })

  it('accepts nullable creator note', () => {
    expect(editEntrySchema.safeParse({ creatorNote: null }).success).toBe(true)
  })
})

describe('cover helpers', () => {
  it('accepts a valid jpeg under 5MB', () => {
    expect(isAcceptableCover({ type: 'image/jpeg', size: 1024 })).toBe(true)
    expect(describeCoverRejection({ type: 'image/jpeg', size: 1024 })).toBeNull()
  })

  it('rejects >5MB', () => {
    expect(
      describeCoverRejection({ type: 'image/png', size: MAX_COVER_UPLOAD_BYTES + 1 }),
    ).not.toBeNull()
    expect(isAcceptableCover({ type: 'image/png', size: MAX_COVER_UPLOAD_BYTES + 1 })).toBe(false)
  })

  it('rejects bad MIME', () => {
    expect(describeCoverRejection({ type: 'image/gif', size: 1024 })).not.toBeNull()
    expect(isAcceptableCover({ type: 'application/pdf', size: 1024 })).toBe(false)
  })

  it('rejects empty file', () => {
    expect(describeCoverRejection({ type: 'image/webp', size: 0 })).not.toBeNull()
  })
})

describe('sanitizePreviewText', () => {
  it('returns null for null/undefined/blank', () => {
    expect(sanitizePreviewText(null, 100)).toBeNull()
    expect(sanitizePreviewText(undefined, 100)).toBeNull()
    expect(sanitizePreviewText('   ', 100)).toBeNull()
  })

  it('strips tags and collapses whitespace', () => {
    expect(sanitizePreviewText('<b>Hello</b>   world\nnewline', 100)).toBe('Hello world newline')
  })

  it('truncates to max', () => {
    expect(sanitizePreviewText('abcdef', 3)).toBe('abc')
  })
})
