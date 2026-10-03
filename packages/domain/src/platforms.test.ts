import { describe, expect, it } from 'vitest'

import { detectPlatform, isContentUrl, platformAppUrl } from './platforms.js'

/**
 * Real-world URL shapes a member is likely to paste.
 *
 * The short-link, mobile-host and missing-scheme cases matter most: they are the
 * ones a naive host-substring check gets wrong.
 */
const CASES: readonly [url: string, expected: string | null][] = [
  // Instagram
  ['https://www.instagram.com/p/CxYz123/', 'instagram'],
  ['https://instagram.com/p/CxYz123/', 'instagram'],
  ['http://instagram.com/p/CxYz123', 'instagram'],
  ['https://www.instagram.com/reel/CxReel99/', 'instagram'],
  ['https://www.instagram.com/tv/CxTv00/', 'instagram'],
  ['instagram.com/p/CxYz123', 'instagram'],
  ['https://www.instagram.com/p/CxYz123/?utm_source=ig_web', 'instagram'],

  // TikTok
  ['https://www.tiktok.com/@creator/video/7123456789', 'tiktok'],
  ['https://vm.tiktok.com/ZM8abc123/', 'tiktok'],
  ['https://vt.tiktok.com/ZSabc123/', 'tiktok'],
  ['https://m.tiktok.com/v/7123456789.html', 'tiktok'],

  // YouTube
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
  ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
  ['https://www.youtube.com/shorts/abc123XYZ', 'youtube'],
  ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
  ['youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'youtube'],

  // X — twitter.com and x.com are the same platform
  ['https://x.com/creator/status/1234567890123456789', 'x'],
  ['https://twitter.com/creator/status/1234567890123456789', 'x'],
  ['https://mobile.twitter.com/creator/status/1234567890123456789', 'x'],
  ['https://nitter.net/creator/status/1234567890123456789', 'x'],
  ['x.com/creator/status/1234567890123456789?s=20', 'x'],

  // Rejections — the interesting half
  ['https://example.com/p/abc', null],
  ['https://notinstagram.com/p/abc', null],
  ['https://instagram.com.evil.example/p/abc', null],
  ['https://youtube.com.evil.example/watch?v=abc', null],
  ['https://myspace.com/creator', null],
  ['', null],
  ['   ', null],
  ['not a url at all', null],
  ['javascript:alert(1)', null],
  ['ftp://youtube.com/watch?v=abc', 'youtube'],
]

describe('detectPlatform', () => {
  it.each(CASES)('detects %s as %s', (url, expected) => {
    expect(detectPlatform(url)).toBe(expected)
  })

  it('is case-insensitive about the host', () => {
    expect(detectPlatform('https://WWW.Instagram.COM/p/abc/')).toBe('instagram')
    expect(detectPlatform('https://WWW.YouTube.COM/watch?v=abc')).toBe('youtube')
  })

  it('tolerates a trailing DNS dot', () => {
    expect(detectPlatform('https://instagram.com./p/abc')).toBe('instagram')
  })

  it('does not match a host that merely contains a platform name', () => {
    // The whole point of label-boundary matching rather than substring matching.
    expect(detectPlatform('https://notyoutube.com/watch?v=abc')).toBeNull()
    expect(detectPlatform('https://youtube.phish.example/watch?v=abc')).toBeNull()
    expect(detectPlatform('https://x.com.evil.example/status/1')).toBeNull()
  })

  it('returns null for empty and whitespace input', () => {
    expect(detectPlatform('')).toBeNull()
    expect(detectPlatform('   \t\n ')).toBeNull()
  })
})

describe('isContentUrl', () => {
  it('recognises real content paths', () => {
    expect(isContentUrl('https://www.instagram.com/p/CxYz123/')).toBe(true)
    expect(isContentUrl('https://www.instagram.com/reel/CxReel99/')).toBe(true)
    expect(isContentUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isContentUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isContentUrl('https://x.com/creator/status/123')).toBe(true)
  })

  it('treats profile and channel pages as non-content', () => {
    expect(isContentUrl('https://www.instagram.com/creator/')).toBe(false)
    expect(isContentUrl('https://www.youtube.com/@channel')).toBe(false)
    expect(isContentUrl('https://x.com/creator')).toBe(false)
  })
})

describe('platformAppUrl', () => {
  it('rewrites the host to the canonical web host while keeping the path', () => {
    expect(platformAppUrl('instagram', 'https://vm.tiktok.com/ZM8abc/')).toContain(
      'www.instagram.com',
    )
    expect(platformAppUrl('youtube', 'https://youtu.be/abc123')).toContain('www.youtube.com')
    expect(platformAppUrl('youtube', 'https://youtu.be/abc123')).toContain('/abc123')
  })

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(platformAppUrl('x', 'not a url')).toBe('not a url')
  })
})
