import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.uuid() })
const bodySchema = z.object({
  status: z.enum(['active', 'hidden', 'removed']),
  note: z.string().trim().max(1000).optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const callerId = await requireUserId()
  const supabase = await memberClient()

  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle()

  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'That action is not allowed.' }, { status: 403 })
  }

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid entry ID.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid status payload.' }, { status: 400 })
  }

  const service = createServiceClient()

  const updateFields: { status: 'active' | 'hidden' | 'removed'; deleted_at?: string | null } = {
    status: parsed.data.status,
  }
  if (parsed.data.status === 'removed') {
    updateFields.deleted_at = new Date().toISOString()
  }

  const { data: entry, error: updateError } = await service
    .from('content_entries')
    .update(updateFields)
    .eq('id', parsedParams.data.id)
    .select()
    .single()

  if (updateError) {
    return NextResponse.json({ error: 'Could not update content entry.' }, { status: 500 })
  }

  await service.from('moderation_actions').insert({
    actor_id: callerId,
    action: parsed.data.status === 'hidden' ? 'entry_hidden' : 'entry_removed',
    target_type: 'content_entry',
    target_id: parsedParams.data.id,
    meta: { status: parsed.data.status, note: parsed.data.note ?? null },
  })

  return NextResponse.json({ ok: true, entry })
}
