import { NextResponse } from 'next/server'

import { submitReportSchema } from '@fydio/domain'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  await requireUserId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = submitReportSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'That report submission is not valid.' }, { status: 400 })
  }

  const supabase = await memberClient()
  const { data: report, error } = await supabase.rpc('report_content', {
    p_target_type: parsed.data.targetType,
    p_target_id: parsed.data.targetId,
    p_reason: parsed.data.reason,
    ...(parsed.data.details ? { p_details: parsed.data.details } : {}),
  })

  if (error) {
    return mapReportError(error.message)
  }

  return NextResponse.json({ ok: true, report }, { status: 201 })
}

function mapReportError(message: string | undefined): NextResponse {
  const text = message ?? ''
  if (text.includes('already reported')) {
    return NextResponse.json({ error: 'You have already reported this item.' }, { status: 409 })
  }
  if (text.includes('cannot report your own') || text.includes('cannot report yourself')) {
    return NextResponse.json({ error: 'You cannot report your own content.' }, { status: 400 })
  }
  if (text.includes('not found')) {
    return NextResponse.json({ error: 'The reported item does not exist.' }, { status: 404 })
  }
  return NextResponse.json({ error: 'That report could not be submitted.' }, { status: 500 })
}
