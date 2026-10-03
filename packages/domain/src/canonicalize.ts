import { detectPlatform } from './platforms.js'

/**
 * Query parameters that identify the same content on every platform we accept.
 * Anything not listed here is preserved, because a stripped parameter can change
 * which piece of content a link points at.
 */
const CAMPAIGN_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'igshid',
  'igsh',
  'si',
  'feature',
  'ref_src',
  'ref_url',
  's',
  'share_id',
  'is_from_webapp',
  'sender_device',
  'web_id',
]

/**
 * Host aliases rewritten to a single canonical host, plus a path rewrite.
 *
 * Without this, the same YouTube video pasted as `youtu.be/ID` and as
 * `youtube.com/watch?v=ID` would be stored as two entries, so a member who spent
 * a credit on a post could see it twice in the feed. The same applies to
 * `twitter.com` versus `x.com`.
 *
 * Each entry returns the canonical host and the path that host should use, given
 * the original pathname and query string.
 */
/**
 * Where an input host should canonically point.
 *
 * `path` and `search` are the original pathname and query string;
 * `host`/`path`/`search` in the result are what to use instead.
 */
interface CanonicalHost {
  /** The host to use instead of the input's. */
  host: string
  /** The path to use on that host. */
  path: string
  /** An optional replacement query string; omitted means "keep the original". */
  search?: string
}

/**
 * A rule that maps an input host's path and query onto a canonical host.
 *
 * Implemented as a rest tuple rather than `(path: string, search: string) => ...`
 * because `eslint`'s `no-unused-vars` reports the parameter names in a function
 * *type* as unused bindings — a false positive that has no correct inline fix.
 */
type HostAlias = (..._args: [path: string, search: string]) => CanonicalHost

const HOST_ALIASES: Record<string, HostAlias> = {
  // youtu.be/ID  ->  youtube.com/watch?v=ID
  'youtu.be': (path, search) => {
    const id = path.replace(/^\/+/, '')
    const params = new URLSearchParams(search)
    params.set('v', id)

    return { host: 'www.youtube.com', path: '/watch', search: params.toString() }
  },

  'youtube.com': (path) => ({ host: 'www.youtube.com', path }),
  'm.youtube.com': (path) => ({ host: 'www.youtube.com', path }),
  'music.youtube.com': (path) => ({ host: 'www.youtube.com', path }),

  // twitter.com and nitter.net are front-ends for x.com; the path is identical.
  'twitter.com': (path) => ({ host: 'x.com', path }),
  'mobile.twitter.com': (path) => ({ host: 'x.com', path }),
  'nitter.net': (path) => ({ host: 'x.com', path }),
  'x.com': (path) => ({ host: 'x.com', path }),

  'instagram.com': (path) => ({ host: 'www.instagram.com', path }),
  'instagr.am': (path) => ({ host: 'www.instagram.com', path }),
  'ddinstagram.com': (path) => ({ host: 'www.instagram.com', path }),

  'tiktok.com': (path) => ({ host: 'www.tiktok.com', path }),
  'vm.tiktok.com': (path) => ({ host: 'www.tiktok.com', path }),
  'vt.tiktok.com': (path) => ({ host: 'www.tiktok.com', path }),
}

/** Resolve a host alias, returning `null` when the host has no alias. */
function resolveHostAlias(
  hostname: string,
  pathname: string,
  search: string,
): { host: string; path: string; search?: string } | null {
  const resolver = HOST_ALIASES[hostname]

  return resolver ? resolver(pathname, search) : null
}

/**
 * Reduce a submitted link to a stable identity.
 *
 * Two members pasting the same post through different paths — one from the app,
 * one from a shared tweet, one with a tracking pixel attached — must produce the
 * same string, or the feed fills with near-duplicates and the credit a member
 * spent looks like it bought nothing.
 *
 * Properties this function guarantees, and that `canonicalize.test.ts` asserts:
 *  - **Idempotent**: `canonicalizeUrl(canonicalizeUrl(u)) === canonicalizeUrl(u)`
 *  - **Total**: never throws; an unparseable input comes back trimmed
 *  - **Stable across host aliases**: `youtu.be` and `youtube.com/watch?v=` agree
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()

  if (trimmed.length === 0) return trimmed

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return trimmed
  }

  // Force https: an http link and its https twin are the same content, and
  // leaving them distinct would split the same post across two feed entries.
  url.protocol = 'https:'
  url.hash = ''

  const platform = detectPlatform(trimmed)

  // Lowercase the host, drop a trailing dot, keep a meaningful `www.` since
  // Instagram and TikTok treat it as canonical.
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  url.port = ''

  // Drop tracking parameters, and sort what remains so parameter order cannot
  // make two identical links compare unequal.
  for (const param of [...url.searchParams.keys()]) {
    if (CAMPAIGN_PARAMS.includes(param.toLowerCase())) {
      url.searchParams.delete(param)
    }
  }
  url.searchParams.sort()

  // Normalise the path only for hosts we recognise: for an arbitrary host the
  // full path may be the identity (e.g. `/docs/page`), and trimming segments we
  // do not understand would merge unrelated links.
  if (platform !== null) {
    url.pathname = normalisePath(url.pathname)
  }

  // Unify host aliases last, so the query that `youtu.be` contributes has
  // already survived the campaign-parameter strip and the sort below.
  const alias = resolveHostAlias(url.hostname, url.pathname, url.searchParams.toString())

  if (alias !== null) {
    url.hostname = alias.host
    url.pathname = alias.path

    if (alias.search !== undefined) {
      url.search = alias.search
    }
  }

  // An empty query and a trailing slash are noise; drop them so the string form
  // is stable regardless of how the member pasted the link.
  if (url.searchParams.toString().length === 0) {
    url.search = ''
  }

  return url.toString().replace(/\/$/, url.pathname === '/' ? '' : '/')
}

/**
 * Reduce a path to its identifying segments.
 *
 * Removes `index.php`, collapses duplicate slashes, and drops trailing noise
 * segments — but never the last meaningful segment, since for most platforms
 * that *is* the post identifier.
 */
/**
 * Leading path segments that are app chrome rather than content identity.
 *
 * Instagram is the case that matters: the same post is reachable as `/p/ABC`
 * and `/reel/ABC`, so both must reduce to the identifier alone. Without this the
 * feed shows the same reel twice and a member's credit bought them a duplicate.
 *
 * `youtu.be/ID` is handled separately by the host alias table, which rewrites the
 * path entirely rather than trimming a segment.
 */
const NOISE_LEADING_SEGMENTS = new Set(['p', 'reel', 'reels', 'tv', 'embed', 'shorts', 'index.php'])

/**
 * Reduce a path to its identifying segments.
 *
 * Removes `index.php`, collapses duplicate slashes, and drops leading noise
 * segments — but never a trailing one, since for most platforms the last segment
 * *is* the identifier.
 */
function normalisePath(pathname: string): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0)

  if (segments.length === 0) return '/'

  // Compare case-insensitively to decide what is chrome, but return the
  // *original* segment. YouTube ids and Instagram shortcodes are case-sensitive,
  // so lowercasing the path would map distinct videos onto one canonical URL.
  const lowered = segments.map((segment) => segment.toLowerCase())

  let start = 0
  // Only strip a leading marker while something is left to identify the content;
  // `/reel` on its own is not a post, and eating it would leave an empty path.
  while (start < lowered.length - 1 && NOISE_LEADING_SEGMENTS.has(String(lowered[start]))) {
    start += 1
  }

  const kept = segments.slice(start)

  if (kept.length === 0) return '/'

  return `/${kept.join('/')}`
}

/**
 * A stable grouping key for "is this the same content as that?".
 *
 * Separate from `canonicalizeUrl` because the UI needs to *display* the URL a
 * member submitted while the database needs to *deduplicate* on it.
 */
export function contentFingerprint(rawUrl: string): string {
  return canonicalizeUrl(rawUrl).toLowerCase()
}

/**
 * Human-readable host, for display as the link's origin.
 *
 * Falls back to the raw string when the input will not parse, because showing a
 * truncated link is better than throwing while rendering a feed card.
 */
export function displayHost(rawUrl: string): string {
  const trimmed = rawUrl.trim()

  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    return new URL(withScheme).hostname.replace(/^www\./, '')
  } catch {
    return trimmed
  }
}
