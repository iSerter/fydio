import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.uuid() })

const bodySchema = z.object({
  state: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(1000).optional(),
})

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
    return NextResponse.json({ error: 'Invalid report ID.' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid resolution payload.' }, { status: 400 })
  }

  const service = createServiceClient()
  const { data: report, error } = await service.rpc('admin_resolve_report', {
    p_report_id: parsedParams.data.id,
    p_state: parsed.data.state,
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  })

  if (error) {
    return mapResolveError(error.message)
  }

  return NextResponse.json({ ok: true, report })
}

function mapResolveError(message: string | undefined): NextResponse {
  const text = message ?? ''
  if (text.includes('Report not found')) {
    return NextResponse.json({ error: 'Report not found.' }, { status: 404 })
  }
  if (text.includes('already closed')) {
    return NextResponse.json({ error: 'This report is already closed.' }, { status: 409 })
  }
  return NextResponse.json({ error: 'Could not resolve that report.' }, { status: 500 })
}
