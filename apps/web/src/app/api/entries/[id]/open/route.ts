import { NextResponse } from 'next/server'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Mark an entry opened (T05 supporting route; telemetry UI in T08, composer in T09).
 *
 * `submit_feedback` requires the author to have opened the entry first (brief
 * §2: feedback is connected to something they opened), and nothing in the app
 * exposed that mark yet — so the earn path was reachable by RPC but not by
 * any member. This route is the smallest honest piece: it records the open
 * history the feedback prerequisite reads, and nothing else. Outbound-click
 * attribution and duration bands stay in T08.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  await requireUserId()
  const { id } = await params

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'That entry does not exist.' }, { status: 404 })
  }

  const supabase = await memberClient()
  const { error } = await supabase.rpc('mark_entry_opened', { p_entry_id: id })

  if (error) {
    // Unknown entry: the impression FK rejects it. Anything else is a server fault.
    if (error.code === '23503') {
      return NextResponse.json({ error: 'That entry does not exist.' }, { status: 404 })
    }
    return NextResponse.json({ error: 'That action could not be saved.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
