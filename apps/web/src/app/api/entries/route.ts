import { NextResponse } from 'next/server'

import { detectSubmission, submitEntrySchema } from '@fydio/domain'

import { platformAllowlist } from '@/lib/env'
import { resolvePreviewSafely } from '@/lib/preview'
import { memberClient, requireUserId } from '@/lib/server'

/**
 * Create a content entry (T04). Spends one Credit atomically via
 * `create_content_entry` — either the entry exists and the Credit is gone,
 * or neither happened.
 *
 * Preview resolution is best-effort and never blocks: failure degrades to a
 * link card (`preview_state='unavailable'`).
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await requireUserId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = submitEntrySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'That submission is not valid.', issues: parsed.error.issues }, { status: 400 })
  }

  const detected = detectSubmission(parsed.data.url)
  if (!detected) {
    return NextResponse.json(
      { error: 'That link is not a supported post on Instagram, TikTok, YouTube, or X.' },
      { status: 400 },
    )
  }

  if (!platformAllowlist().includes(detected.platform)) {
    return NextResponse.json(
      { error: `${detected.platform} is not currently allowed.` },
      { status: 400 },
    )
  }

  const preview = await resolvePreviewSafely({ url: detected.canonicalUrl, platform: detected.platform })

  const supabase = await memberClient()

  const rpcArgs: {
    p_platform: typeof detected.platform
    p_url: string
    p_canonical_url: string
    p_hashtags: string[]
    p_title?: string
    p_caption?: string
    p_creator_note?: string
    p_asks_for_feedback: boolean
    p_cover_path?: string
  } = {
    p_platform: detected.platform,
    p_url: parsed.data.url.trim(),
    p_canonical_url: detected.canonicalUrl,
    p_hashtags: parsed.data.hashtagIds,
    p_asks_for_feedback: parsed.data.asksForFeedback,
  }
  if (preview.title) rpcArgs.p_title = preview.title
  if (preview.caption) rpcArgs.p_caption = preview.caption
  const trimmedNote = parsed.data.creatorNote?.trim()
  if (trimmedNote) rpcArgs.p_creator_note = trimmedNote
  if (parsed.data.coverPath) {
    const coverPath = parsed.data.coverPath.trim()
    // Covers upload to `{userId}/…` before the entry exists. Only accept a path
    // in the caller's own folder, with no traversal, so one member cannot claim
    // another member's cover or store an arbitrary string as thumbnail_path.
    if (!coverPath.startsWith(`${userId}/`) || coverPath.includes('..')) {
      return NextResponse.json({ error: 'That cover is not valid. Upload it again.' }, { status: 400 })
    }
    rpcArgs.p_cover_path = coverPath
  }

  const { data, error } = await supabase.rpc('create_content_entry', rpcArgs)

  if (error) {
    return mapDbError(error.code, error.message)
  }

  // Persist preview metadata best-effort. The RPC already stored title/caption;
  // this upgrades preview_state/thumbnail without ever failing the request.
  const entryId = (data as { id?: unknown } | null)?.id
  if (typeof entryId === 'string' && entryId.length > 0) {
    if (preview.previewState === 'resolved') {
      await supabase
        .from('content_entries')
        .update({
          preview_state: 'resolved',
          thumbnail_source: preview.thumbnailSource,
          preview_meta: preview.authorName ? { author_name: preview.authorName } : {},
        })
        .eq('id', entryId)
    } else {
      await supabase.from('content_entries').update({ preview_state: 'unavailable' }).eq('id', entryId)
    }
  }

  return NextResponse.json({ ok: true, entry: data }, { status: 201 })
}

function mapDbError(code: string, message: string): NextResponse {
  // Insufficient Credits surfaces verbatim — the member must know why.
  // Scoped to the check_violation raised by create_content_entry so an unrelated
  // 23514 never reports as a balance problem.
  if (code === '23514' && message.includes('Insufficient Credits')) {
    return NextResponse.json({ error: message }, { status: 402 })
  }
  if (message.includes('already submitted')) {
    return NextResponse.json({ error: 'You have already submitted this URL.' }, { status: 409 })
  }
  // 23505 alone is not proof of a duplicate URL — it fires for any unique
  // violation. Only the duplicate-URL message maps to 409; anything else is an
  // unexpected persistence failure, not a message about the member's link.
  if (code === '23505') {
    return NextResponse.json({ error: 'That submission could not be saved.' }, { status: 500 })
  }
  if (code === '23514' || code === '23503') {
    return NextResponse.json({ error: message }, { status: 400 })
  }
  if (code === '42501') {
    return NextResponse.json({ error: 'That action is not allowed.' }, { status: 403 })
  }
  return NextResponse.json({ error: 'That submission could not be saved.' }, { status: 500 })
}
