import 'server-only'

import {
  MAX_ENTRY_CAPTION_CHARS,
  MAX_ENTRY_TITLE_CHARS,
  sanitizePreviewText,
} from '@fydio/domain'

import { previewTimeoutMs } from '@/lib/env'
import { getServerEnv } from '@fydio/env/server'

/**
 * Best-effort preview resolution (T04).
 *
 * Previews must NEVER block submission: if the resolver is unreachable, slow,
 * or returns nothing usable, the entry is created with `preview_state='unavailable'`
 * and renders as a link card. A preview outage must never cost a member their credit.
 */

export interface ResolvedPreview {
  readonly title: string | null
  readonly caption: string | null
  readonly thumbnailSource: string | null
  readonly authorName: string | null
  readonly previewState: 'resolved' | 'unavailable'
}

const UNAVAILABLE: ResolvedPreview = {
  title: null,
  caption: null,
  thumbnailSource: null,
  authorName: null,
  previewState: 'unavailable',
}

/**
 * Resolve a preview via the `resolve-preview` Edge Function, with a hard timeout.
 * Any failure — network, timeout, malformed payload — degrades to unavailable.
 */
export async function resolvePreviewSafely(args: {
  url: string
  platform: string
  timeoutMs?: number
}): Promise<ResolvedPreview> {
  const timeoutMs = args.timeoutMs ?? previewTimeoutMs()

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const env = getServerEnv()
    const response = await fetch(`${env.SUPABASE_URL}/functions/v1/resolve-preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ url: args.url, platform: args.platform }),
      signal: controller.signal,
    })

    if (!response.ok) return UNAVAILABLE

    const payload = (await response.json().catch(() => null)) as {
      previewState?: unknown
      title?: unknown
      caption?: unknown
      thumbnailSource?: unknown
      authorName?: unknown
    } | null

    if (payload?.previewState !== 'resolved') return UNAVAILABLE

    const title = sanitizePreviewText(
      typeof payload.title === 'string' ? payload.title : null,
      MAX_ENTRY_TITLE_CHARS,
    )
    const caption = sanitizePreviewText(
      typeof payload.caption === 'string' ? payload.caption : null,
      MAX_ENTRY_CAPTION_CHARS,
    )
    const authorName = sanitizePreviewText(
      typeof payload.authorName === 'string' ? payload.authorName : null,
      80,
    )
    // Overlong thumbnail URLs are rejected, not truncated: slicing mid-URL
    // produces a well-formed string that 404s instead of a clean fallback.
    const rawThumbnail =
      typeof payload.thumbnailSource === 'string' && payload.thumbnailSource.startsWith('https://')
        ? payload.thumbnailSource
        : null
    const thumbnailSource =
      rawThumbnail !== null && rawThumbnail.length <= 2000 ? rawThumbnail : null

    if (title === null && caption === null && thumbnailSource === null) return UNAVAILABLE

    return { title, caption, thumbnailSource, authorName, previewState: 'resolved' }
  } catch {
    return UNAVAILABLE
  } finally {
    clearTimeout(timer)
  }
}
