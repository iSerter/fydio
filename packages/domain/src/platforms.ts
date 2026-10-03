import type { Platform } from './constants.js'

/**
 * Hosts that identify each platform.
 *
 * Matching is on the registrable host and its immediate subdomain labels rather
 * than a substring of the full URL, so `https://evil.example/instagram.com/p/1`
 * cannot masquerade as an Instagram link. Substring matching here is a
 * well-known way to get a phishing link past a content filter.
 */
const PLATFORM_HOSTS: Record<Platform, readonly string[]> = {
  instagram: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
  tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  youtube: ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'],
  x: ['x.com', 'twitter.com', 'mobile.twitter.com', 'nitter.net'],
}

/**
 * Path prefixes that identify a platform's *content* rather than a profile or
 * a settings page. Used to warn about non-post links, not to reject them —
 * `detectPlatform` only needs the platform, and T04 owns submission validation.
 */
const CONTENT_PATH_PREFIXES: Record<Platform, readonly string[]> = {
  instagram: ['/p/', '/reel/', '/reels/', '/tv/'],
  tiktok: ['/video/', '/t/', '/photo/'],
  youtube: ['/watch', '/shorts/', '/embed/', '/live/'],
  x: ['/status/'],
}

/**
 * Strip a leading `www.`, lowercase, and drop a trailing dot.
 *
 * A trailing dot is legal in DNS (`instagram.com.`) and resolves the same, so it
 * has to go or the same link canonicalises two different ways.
 */
function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

/**
 * Does `host` (or a parent of it) belong to `platform`?
 *
 * Walks up the labels so `www.instagram.com` and `instagram.com` both match,
 * while `notinstagram.com` does not.
 */
function hostMatches(host: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/** Extract a hostname from a URL string, tolerating input that omits a scheme. */
function extractHost(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()

  if (trimmed.length === 0) return null

  // `new URL` needs a scheme; assume https when the member omitted one, which is
  // what a bare pasted host almost always means.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    return normaliseHost(new URL(withScheme).hostname)
  } catch {
    return null
  }
}

/**
 * Identify the platform a link belongs to.
 *
 * Returns `null` for anything Fydio does not accept — the caller decides whether
 * that is a validation error. Detection is intentionally forgiving about
 * *shape* (short links, mobile hosts, missing scheme) and strict about
 * *domain* (label-boundary matching), because getting the domain wrong means
 * storing a link under the wrong platform.
 */
export function detectPlatform(rawUrl: string): Platform | null {
  const host = extractHost(rawUrl)

  if (host === null) return null

  for (const platform of Object.keys(PLATFORM_HOSTS) as Platform[]) {
    if (hostMatches(host, PLATFORM_HOSTS[platform])) {
      return platform
    }
  }

  return null
}

/**
 * Does this link look like a specific piece of content rather than a profile,
 * channel or settings page?
 *
 * Advisory only: `detectPlatform` is the gate, this shapes the warning copy.
 */
export function isContentUrl(rawUrl: string): boolean {
  const platform = detectPlatform(rawUrl)

  if (platform === null) return false

  const trimmed = rawUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let pathname: string
  try {
    pathname = new URL(withScheme).pathname
  } catch {
    return false
  }

  // `youtu.be/<id>` puts the video id directly in the first path segment, with
  // no `/watch` prefix to match, so it needs its own rule.
  if (platform === 'youtube' && /^\/[A-Za-z0-9_-]{6,}$/.test(pathname)) {
    return true
  }

  return CONTENT_PATH_PREFIXES[platform].some((prefix) => matchesPathPrefix(pathname, prefix))
}

/**
 * Does `pathname` contain `prefix` at a segment boundary?
 *
 * A plain `startsWith` is wrong for X, where a post lives at
 * `/<handle>/status/<id>` — the marker is in the middle of the path, not at the
 * start. Matching on a segment boundary (`/status/` rather than `status`)
 * avoids the false positives that a bare `includes` would allow, e.g.
 * `/user/statuspage/123` is not a post.
 */
function matchesPathPrefix(pathname: string, prefix: string): boolean {
  const segment = prefix.startsWith('/') ? prefix : `/${prefix}`

  return pathname.startsWith(segment) || pathname.includes(segment)
}

/**
 * The web app URL a platform uses to open a link in its own context.
 *
 * Not used to rewrite the submitted URL — Fydio always links to the exact URL a
 * member submitted — but to offer a "open in app" affordance on mobile.
 */
export function platformAppUrl(platform: Platform, rawUrl: string): string {
  const trimmed = rawUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return trimmed
  }

  switch (platform) {
    case 'instagram':
      url.hostname = 'www.instagram.com'
      return url.toString()
    case 'tiktok':
      url.hostname = 'www.tiktok.com'
      return url.toString()
    case 'youtube':
      url.hostname = 'www.youtube.com'
      return url.toString()
    case 'x':
      // X has no dedicated scheme; the app opens from the universal link.
      url.hostname = 'x.com'
      return url.toString()
  }
}
