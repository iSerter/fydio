import { describe, expect, it } from 'vitest'

import { PLATFORM_LABELS, canonicalizeUrl, detectPlatform, rankFeed } from '@fydio/domain'

/**
 * Smoke coverage for the web app.
 *
 * T01 has no product surface, so this asserts the things a broken foundation
 * would break: the shared packages resolve from the app, and the values the
 * landing page renders come from code that is actually exercised. T02+ replace
 * this with real component tests.
 */
describe('web app foundation', () => {
  it('resolves the shared domain package', () => {
    expect(detectPlatform('https://youtu.be/abc123')).toBe('youtube')
    expect(canonicalizeUrl('https://twitter.com/a/status/1')).toBe(
      canonicalizeUrl('https://x.com/a/status/1'),
    )
  })

  it('exposes a display label for every supported platform', () => {
    for (const platform of ['instagram', 'tiktok', 'youtube', 'x'] as const) {
      expect(PLATFORM_LABELS[platform]).toBeTruthy()
    }
  })

  it('can rank an empty feed without throwing', () => {
    const result = rankFeed([], {
      viewerId: 'viewer-1',
      profileHashtags: ['design'],
      likedHashtags: [],
      seenEntryIds: [],
      seenAuthors: new Map(),
      seenPlatforms: new Map(),
    })

    expect(result).toEqual([])
  })
})
