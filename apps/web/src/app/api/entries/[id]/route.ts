import { NextResponse } from 'next/server'

import { editEntrySchema } from '@fydio/domain'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Entry lifecycle for the author (T04): edit hashtags/note/flag, hide/unhide, remove.
 *
 * PATCH /api/entries/[id] { hashtagIds?, creatorNote?, asksForFeedback?, hidden? }
 * DELETE /api/entries/[id] -> soft remove (status='removed'). No refund path exists.
 */
export const dynamic = 'force-dynamic'

function asId(value: string | undefined): string | null {
  if (!value) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  await requireUserId()
  const { id } = await ctx.params
  const entryId = asId(id)
  if (!entryId) return NextResponse.json({ error: 'That entry no longer exists.' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const raw = body as { hashtagIds?: unknown; creatorNote?: unknown; asksForFeedback?: unknown; hidden?: unknown }
  const parsed = editEntrySchema.safeParse({
    hashtagIds: raw.hashtagIds,
    creatorNote: raw.creatorNote,
    asksForFeedback: raw.asksForFeedback,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Those changes are not valid.', issues: parsed.error.issues }, { status: 400 })
  }

  const supabase = await memberClient()

  const hasFieldEdits =
    parsed.data.hashtagIds !== undefined ||
    parsed.data.creatorNote !== undefined ||
    parsed.data.asksForFeedback !== undefined
  const hasHiddenChange = raw.hidden !== undefined

  // Field edits and visibility changes are separate transactions (update_entry /
  // set_entry_hashtags, then hide_entry). Applying one and failing the other
  // would leave a partial update behind an error response, so combined requests
  // are refused rather than applied halfway.
  if (hasFieldEdits && hasHiddenChange) {
    return NextResponse.json(
      { error: 'Send field edits and visibility changes separately.' },
      { status: 400 },
    )
  }
  if (hasHiddenChange && typeof raw.hidden !== 'boolean') {
    return NextResponse.json({ error: 'Those changes are not valid.' }, { status: 400 })
  }

  if (parsed.data.hashtagIds) {
    const { error } = await supabase.rpc('set_entry_hashtags', {
      p_entry_id: entryId,
      p_hashtags: parsed.data.hashtagIds,
    })
    if (error) return mapError(error.code, error.message)
  }

  if (parsed.data.creatorNote !== undefined || parsed.data.asksForFeedback !== undefined) {
    const updateArgs: { p_entry_id: string; p_creator_note?: string; p_asks_for_feedback?: boolean } = {
      p_entry_id: entryId,
    }
    if (parsed.data.creatorNote !== undefined && parsed.data.creatorNote !== null) {
      updateArgs.p_creator_note = parsed.data.creatorNote
    } else if (parsed.data.creatorNote === null) {
      updateArgs.p_creator_note = ''
    }
    if (parsed.data.asksForFeedback !== undefined) {
      updateArgs.p_asks_for_feedback = parsed.data.asksForFeedback
    }
    const { data, error } = await supabase.rpc('update_entry', updateArgs)
    if (error) return mapError(error.code, error.message)
    return NextResponse.json({ ok: true, entry: data })
  }

  if (raw.hidden !== undefined) {
    const hideResult = await setHidden(supabase, entryId, raw.hidden === true)
    if (hideResult) return hideResult
    const { data } = await supabase.from('content_entries').select('*').eq('id', entryId).maybeSingle()
    return NextResponse.json({ ok: true, entry: data })
  }

  return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  await requireUserId()
  const { id } = await ctx.params
  const entryId = asId(id)
  if (!entryId) return NextResponse.json({ error: 'That entry no longer exists.' }, { status: 404 })

  const supabase = await memberClient()
  const { data, error } = await supabase.rpc('remove_entry', { p_entry_id: entryId })
  if (error) return mapError(error.code, error.message)
  return NextResponse.json({ ok: true, entry: data })
}

async function setHidden(
  supabase: Awaited<ReturnType<typeof memberClient>>,
  entryId: string,
  hidden: boolean,
): Promise<NextResponse | null> {
  const { data, error } = hidden
    ? await supabase.rpc('hide_entry', { p_entry_id: entryId })
    : await supabase.rpc('unhide_entry', { p_entry_id: entryId })
  if (error) return mapError(error.code, error.message)
  return NextResponse.json({ ok: true, entry: data })
}

function mapError(code: string, message: string): NextResponse {
  if (code === '42501') return NextResponse.json({ error: 'That entry is not yours to change.' }, { status: 403 })
  if (code === 'P0002') return NextResponse.json({ error: 'That entry no longer exists.' }, { status: 404 })
  if (code === '23514' || code === '23503' || code === '23505') {
    return NextResponse.json({ error: message }, { status: 400 })
  }
  return NextResponse.json({ error: 'Those changes could not be saved.' }, { status: 500 })
}
