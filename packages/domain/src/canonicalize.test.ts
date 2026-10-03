import { describe, expect, it } from 'vitest'

import { canonicalizeUrl, contentFingerprint, displayHost } from './canonicalize.js'

/**
 * The property that matters most: canonicalization is idempotent.
 *
 * `canonicalizeUrl(canonicalizeUrl(u)) === canonicalizeUrl(u)` for every input.
 * Without it, re-saving an entry would keep changing its stored identity and the
 * feed would accumulate duplicates that no amount of de-duplication could clear.
 */
const CORPUS: readonly string[] = [
  'https://www.instagram.com/p/CxYz123/',
  'https://www.instagram.com/p/CxYz123/?utm_source=ig_web&utm_medium=share',
  'https://instagram.com/p/CxYz123',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://x.com/creator/status/1234567890',
  'https://twitter.com/creator/status/1234567890?s=20',
  'https://www.tiktok.com/@creator/video/7123456789',
  'https://www.tiktok.com/@creator/video/7123456789#hash',
  'not a url',
  '',
]

describe('canonicalizeUrl', () => {
  it('is idempotent across a corpus of real links', () => {
    for (const url of CORPUS) {
      const once = canonicalizeUrl(url)
      expect(canonicalizeUrl(once), `not idempotent for: ${url}`).toBe(once)
    }
  })

  it('collapses tracking parameters and trailing slashes', () => {
    expect(canonicalizeUrl('https://www.instagram.com/p/abc/?utm_source=ig_web')).toBe(
      canonicalizeUrl('https://www.instagram.com/p/abc/'),
    )
  })

  it('collapses youtu.be and youtube.com/watch forms to the same identity', () => {
    expect(canonicalizeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      canonicalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    )
  })

  it('collapses x.com and twitter.com to the same identity', () => {
    expect(canonicalizeUrl('https://twitter.com/creator/status/123?s=20')).toBe(
      canonicalizeUrl('https://x.com/creator/status/123'),
    )
  })

  it('forces https and drops the fragment', () => {
    expect(canonicalizeUrl('http://example.com/p/abc#section')).not.toContain('http://')
    expect(canonicalizeUrl('http://example.com/p/abc#section')).not.toContain('#')
  })

  it('returns unparseable input trimmed rather than throwing', () => {
    expect(canonicalizeUrl('  not a url  ')).toBe('not a url')
    expect(canonicalizeUrl('')).toBe('')
  })

  it('preserves parameters that change which content a link points at', () => {
    // `t` is a YouTube timestamp and `list` changes the playlist; neither is noise.
    const withTimestamp = canonicalizeUrl('https://www.youtube.com/watch?v=abc&t=42')
    const withoutTimestamp = canonicalizeUrl('https://www.youtube.com/watch?v=abc')

    expect(withTimestamp).not.toBe(withoutTimestamp)
  })

  it('is stable when parameters arrive in a different order', () => {
    expect(canonicalizeUrl('https://www.youtube.com/watch?v=abc&list=def')).toBe(
      canonicalizeUrl('https://www.youtube.com/watch?list=def&v=abc'),
    )
  })
})

describe('contentFingerprint', () => {
  it('gives the same fingerprint for equivalent links', () => {
    expect(contentFingerprint('https://youtu.be/abc')).toBe(
      contentFingerprint('https://www.youtube.com/watch?v=abc'),
    )
  })

  it('gives different fingerprints for different content', () => {
    expect(contentFingerprint('https://youtu.be/abc')).not.toBe(
      contentFingerprint('https://youtu.be/def'),
    )
  })
})

describe('displayHost', () => {
  it('strips the scheme and a leading www', () => {
    expect(displayHost('https://www.instagram.com/p/abc')).toBe('instagram.com')
  })

  it('falls back to the raw string when unparseable', () => {
    expect(displayHost('garbage')).toBe('garbage')
  })
})
