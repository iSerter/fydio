import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.uuid() })
const bodySchema = z.object({ role: z.enum(['member', 'admin']) })

export async function POST(
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
    return NextResponse.json({ error: 'Invalid user ID.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid role payload.' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: profile, error } = await service.rpc('admin_set_role', {
    p_user_id: parsedParams.data.id,
    p_role: parsed.data.role,
  })

  if (error) {
    if (error.message.includes('last admin')) {
      return NextResponse.json({ error: 'Cannot demote the last admin.' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Could not change role.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, profile })
}
