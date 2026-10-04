import { describe, expect, it } from 'vitest'

import {
  describeAvatarRejection,
  displayNameSchema,
  handleSchema,
  isAcceptableAvatar,
  normalizeHandle,
  normalizeHashtagSlug,
  profileLinksSchema,
} from './profile.js'
import {
  MAX_AVATAR_UPLOAD_BYTES,
  MAX_DISPLAY_NAME_CHARS,
  MAX_HASHTAG_CHARS,
} from './constants.js'

/**
 * The slug grammar here must agree with `normalize_hashtag` (migration 0012) and the
 * `hashtags_slug_format` CHECK (0002). The seeded vocabulary contains hyphens, so a
 * normaliser that stripped them would make every existing tag unreachable through the
 * picker -- invisible but still attached to profiles and entries.
 */
describe('normalizeHashtagSlug', () => {
  it('strips a leading hash', () => {
    expect(normalizeHashtagSlug('#Design')).toBe('design')
    expect(normalizeHashtagSlug('###Design')).toBe('design')
  })

  it('lowercases and trims', () => {
    expect(normalizeHashtagSlug('  HOOKS  ')).toBe('hooks')
  })

  it('keeps hyphens, which the seeded vocabulary depends on', () => {
    expect(normalizeHashtagSlug('hook-analysis')).toBe('hook-analysis')
    expect(normalizeHashtagSlug('color-grading')).toBe('color-grading')
  })

  it('canonicalises underscores to hyphens', () => {
    expect(normalizeHashtagSlug('snake_case')).toBe('snake-case')
    expect(normalizeHashtagSlug('snake-case')).toBe('snake-case')
  })

  it('replaces runs of other characters with a single hyphen', () => {
    expect(normalizeHashtagSlug('Color Grading')).toBe('color-grading')
    expect(normalizeHashtagSlug('a   b')).toBe('a-b')
  })

  it('collapses doubled separators and trims the ends', () => {
    expect(normalizeHashtagSlug('##hook--analysis##')).toBe('hook-analysis')
    expect(normalizeHashtagSlug('---front---')).toBe('front')
  })

  it('rejects input that cannot become a valid slug', () => {
    expect(normalizeHashtagSlug('a')).toBeNull()
    expect(normalizeHashtagSlug('#')).toBeNull()
    expect(normalizeHashtagSlug('---')).toBeNull()
    expect(normalizeHashtagSlug('!')).toBeNull()
    expect(normalizeHashtagSlug('a'.repeat(MAX_HASHTAG_CHARS + 1))).toBeNull()
  })

  it('accepts exactly the bounds', () => {
    expect(normalizeHashtagSlug('ab')).not.toBeNull()
    expect(normalizeHashtagSlug('a'.repeat(MAX_HASHTAG_CHARS))).not.toBeNull()
  })

  it('is idempotent -- normalising a slug changes nothing', () => {
    // This is the property the database relies on: `normalize_hashtag(slug) = slug` for
    // every stored tag, which is what makes the lookup in `create_hashtag` reliable.
    for (const raw of ['#Design', 'Color Grading', 'snake_case', 'hook--analysis', '  HOOKS ']) {
      const once = normalizeHashtagSlug(raw)
      expect(once).not.toBeNull()
      expect(normalizeHashtagSlug(once ?? '')).toBe(once)
    }
  })
})

describe('displayNameSchema', () => {
  it('accepts a reasonable name', () => {
    expect(displayNameSchema.safeParse('Ada Lovelace').success).toBe(true)
  })

  it('trims before validating', () => {
    const parsed = displayNameSchema.safeParse('  Ada  ')
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toBe('Ada')
  })

  it('rejects names that are too short or too long', () => {
    expect(displayNameSchema.safeParse('a').success).toBe(false)
    expect(displayNameSchema.safeParse('  a  ').success).toBe(false)
    expect(displayNameSchema.safeParse('a'.repeat(MAX_DISPLAY_NAME_CHARS + 1)).success).toBe(
      false,
    )
  })

  it('accepts exactly the maximum length', () => {
    expect(displayNameSchema.safeParse('a'.repeat(MAX_DISPLAY_NAME_CHARS)).success).toBe(true)
  })
})

describe('handleSchema', () => {
  it('lowercases so a shared URL matches the address bar', () => {
    const parsed = handleSchema.safeParse('  AdaLovelace  ')
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toBe('adalovelace')
  })

  it('rejects handles the database CHECK would refuse', () => {
    expect(handleSchema.safeParse('ab').success).toBe(false) // too short
    expect(handleSchema.safeParse('a'.repeat(31)).success).toBe(false) // too long
    expect(handleSchema.safeParse('has-hyphen').success).toBe(false) // hyphens are not allowed
    expect(handleSchema.safeParse('has space').success).toBe(false)
  })

  it('normalises the same way the schema validates', () => {
    expect(normalizeHandle('  AdaLovelace ')).toBe('adalovelace')
  })
})

describe('profileLinksSchema', () => {
  it('accepts a matching platform and URL', () => {
    const result = profileLinksSchema.safeParse([
      { platform: 'instagram', url: 'https://instagram.com/ada' },
    ])
    expect(result.success).toBe(true)
  })

  it('rejects a URL filed under the wrong platform', () => {
    const result = profileLinksSchema.safeParse([
      { platform: 'tiktok', url: 'https://instagram.com/ada' },
    ])
    expect(result.success).toBe(false)
  })

  it('rejects two links for the same platform', () => {
    const result = profileLinksSchema.safeParse([
      { platform: 'instagram', url: 'https://instagram.com/ada' },
      { platform: 'instagram', url: 'https://instagram.com/ada2' },
    ])
    expect(result.success).toBe(false)
  })

  it('rejects a host that merely mentions a platform', () => {
    // `platforms.ts` matches on label boundaries precisely so this cannot pass.
    const result = profileLinksSchema.safeParse([
      { platform: 'instagram', url: 'https://evil.example/instagram.com/p/1' },
    ])
    expect(result.success).toBe(false)
  })
})

describe('avatar rules', () => {
  it('accepts the three supported image types under the size limit', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(isAcceptableAvatar({ type, size: 1024 })).toBe(true)
    }
  })

  it('rejects a non-image MIME type', () => {
    expect(isAcceptableAvatar({ type: 'application/pdf', size: 1024 })).toBe(false)
    expect(describeAvatarRejection({ type: 'application/pdf', size: 1024 })).toBe(
      'Use a JPEG, PNG or WebP image',
    )
  })

  it('rejects a file over 5 MB', () => {
    const tooBig = { type: 'image/png', size: MAX_AVATAR_UPLOAD_BYTES + 1 }
    expect(isAcceptableAvatar(tooBig)).toBe(false)
    expect(describeAvatarRejection(tooBig)).toBe('Images must be 5 MB or smaller')
  })

  it('accepts a file at exactly the size limit', () => {
    expect(isAcceptableAvatar({ type: 'image/png', size: MAX_AVATAR_UPLOAD_BYTES })).toBe(true)
  })

  it('rejects an empty file', () => {
    expect(isAcceptableAvatar({ type: 'image/png', size: 0 })).toBe(false)
  })
})