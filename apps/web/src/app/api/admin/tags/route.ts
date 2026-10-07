import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const postSchema = z.object({
  slug: z.string().trim().min(2).max(40),
  label: z.string().trim().min(2).max(60).optional(),
  isOfficial: z.boolean().default(true),
})

const patchSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(2).max(60).optional(),
  isOfficial: z.boolean().optional(),
})

export async function POST(request: Request): Promise<NextResponse> {
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tag data.' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: tag, error } = await service
    .from('hashtags')
    .insert({
      slug: parsed.data.slug.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
      label: parsed.data.label ?? parsed.data.slug,
      is_official: parsed.data.isOfficial,
      created_by: callerId,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Tag already exists.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Could not create tag.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, tag }, { status: 201 })
}

export async function PATCH(request: Request): Promise<NextResponse> {
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

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid tag data.' }, { status: 400 })
  }

  const service = createServiceClient()
  const updateData: { label?: string; is_official?: boolean } = {}
  if (parsed.data.label !== undefined) updateData.label = parsed.data.label
  if (parsed.data.isOfficial !== undefined) updateData.is_official = parsed.data.isOfficial

  const { data: tag, error } = await service
    .from('hashtags')
    .update(updateData)
    .eq('id', parsed.data.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: 'Could not update tag.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, tag })
}
