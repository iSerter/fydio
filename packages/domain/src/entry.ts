import { z } from 'zod'

import { canonicalizeUrl } from './canonicalize.js'
import {
  COVER_MIME_TYPES,
  MAX_COVER_UPLOAD_BYTES,
  MAX_CREATOR_NOTE_CHARS,
  MAX_ENTRY_CAPTION_CHARS,
  MAX_ENTRY_TITLE_CHARS,
  type Platform,
} from './constants.js'

/**
 * Strict submission detector (T04).
 *
 * Unlike `detectPlatform` in `platforms.ts` — which is intentionally forgiving
 * about shape (missing scheme, short links) — this is the submission gate: the
 * input must parse as-is with `new URL()`, must be `https:`, must sit on a
 * known host, and must carry a content path hint. Anything else returns `null`
 * and the caller decides how to report it.
 */

const SUBMISSION_HOSTS: Record<Platform, readonly string[]> = {
  instagram: ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  youtube: [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
  ],
  x: [
    'x.com',
    'www.x.com',
    'mobile.x.com',
    'twitter.com',
    'www.twitter.com',
    'mobile.twitter.com',
  ],
}

const INSTAGRAM_PATH_HINTS = [/^\/p\/\S+/, /^\/reel\/\S+/, /^\/reels\/\S+/, /^\/tv\/\S+/]
const TIKTOK_PATH_HINTS = [/^\/video\/\S+/, /^\/@[\w.-]+\/video\/\S+/, /^\/t\/\S+/]
const YOUTUBE_PREFIX_HINTS = [/^\/shorts\/\S+/, /^\/live\/\S+/, /^\/embed\/\S+/, /^\/v\/\S+/]
const X_STATUS_HINT = /^\/[\w.-]+\/status\/\d+($|\/)/
const YOUTU_BE_ID_HINT = /^\/[A-Za-z0-9_-]{6,}/

function hostMatches(host: string, candidates: readonly string[]): boolean {
  return candidates.some((h) => host === h || host.endsWith(`.${h}`))
}

function pathHasContentHint(
  platform: Platform,
  host: string,
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  switch (platform) {
    case 'instagram':
      return INSTAGRAM_PATH_HINTS.some((re) => re.test(pathname))
    case 'tiktok':
      if (TIKTOK_PATH_HINTS.some((re) => re.test(pathname))) return true
      // vm/vt short links carry the id as the whole path (e.g. /AbC123).
      if ((host === 'vm.tiktok.com' || host.endsWith('.vm.tiktok.com')) && pathname.length > 1)
        return true
      if ((host === 'vt.tiktok.com' || host.endsWith('.vt.tiktok.com')) && pathname.length > 1)
        return true
      return false
    case 'youtube':
      if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
        return YOUTU_BE_ID_HINT.test(pathname)
      }
      // /watch?v=<id> is the only query-based content path; bare /watch is chrome.
      if (pathname === '/watch' || pathname.startsWith('/watch/')) {
        const v = searchParams.get('v')
        return typeof v === 'string' && v.trim().length > 0
      }
      return YOUTUBE_PREFIX_HINTS.some((re) => re.test(pathname))
    case 'x':
      return X_STATUS_HINT.test(pathname)
  }
}

export function detectSubmission(input: string): { platform: Platform; canonicalUrl: string } | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  // Strict: no scheme-tolerance. Must parse exactly as pasted.
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/\.$/, '')

  const platforms: Platform[] = ['instagram', 'tiktok', 'youtube', 'x']
  let platform: Platform | null = null
  for (const p of platforms) {
    if (hostMatches(host, SUBMISSION_HOSTS[p])) {
      platform = p
      break
    }
  }
  if (platform === null) return null

  if (!pathHasContentHint(platform, host, url.pathname, url.searchParams)) return null

  return { platform, canonicalUrl: canonicalizeUrl(trimmed) }
}

/* --- Schemas ------------------------------------------------------------------ */

const hashtagId = z.uuid()

export const submitEntrySchema = z
  .object({
    url: z.url(),
    hashtagIds: z.array(hashtagId).length(3),
    creatorNote: z.string().trim().max(MAX_CREATOR_NOTE_CHARS).optional(),
    asksForFeedback: z.boolean().default(false),
    coverPath: z.string().min(1).max(500).optional(),
    title: z.string().trim().max(MAX_ENTRY_TITLE_CHARS).optional(),
    caption: z.string().trim().max(MAX_ENTRY_CAPTION_CHARS).optional(),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.hashtagIds).size !== value.hashtagIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['hashtagIds'],
        message: 'Hashtags must not repeat',
      })
    }
  })

export type SubmitEntryInput = z.input<typeof submitEntrySchema>
export type SubmitEntryOutput = z.output<typeof submitEntrySchema>

export const editEntrySchema = z
  .object({
    hashtagIds: z.array(hashtagId).length(3).optional(),
    creatorNote: z.string().trim().max(MAX_CREATOR_NOTE_CHARS).nullable().optional(),
    asksForFeedback: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.hashtagIds && new Set(value.hashtagIds).size !== value.hashtagIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['hashtagIds'],
        message: 'Hashtags must not repeat',
      })
    }
  })

export type EditEntryInput = z.input<typeof editEntrySchema>
export type EditEntryOutput = z.output<typeof editEntrySchema>

/* --- Cover helpers ------------------------------------------------------------ */

/**
 * A readable explanation for a rejected cover upload, or `null` when acceptable.
 */
export function describeCoverRejection(file: { type: string; size: number }): string | null {
  const allowed = new Set<string>([...COVER_MIME_TYPES])
  if (!allowed.has(file.type)) return 'Use a JPEG, PNG or WebP image'
  if (file.size === 0) return 'That file is empty'
  if (file.size > MAX_COVER_UPLOAD_BYTES) return 'Covers must be 5 MB or smaller'
  return null
}

/** Is this a cover we will accept? Declared MIME type and size only. */
export function isAcceptableCover(file: { type: string; size: number }): boolean {
  return describeCoverRejection(file) === null
}

/* --- Preview sanitize --------------------------------------------------------- */

/**
 * Strip tags, collapse whitespace, trim, and truncate to `max` chars.
 * Returns `null` for missing/empty input.
 */
export function sanitizePreviewText(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null
  const stripped = raw.replace(/<[^>]*>/g, '')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return null
  return collapsed.slice(0, max)
}
