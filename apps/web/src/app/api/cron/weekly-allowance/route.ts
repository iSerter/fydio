import { NextResponse } from 'next/server'

import { createServiceClient } from '@fydio/supabase/service'

import { refuseCron } from '../guard'

/**
 * Weekly starter-credit allowance trigger (T05; scheduled in T10).
 *
 * The RPC is idempotent per ISO week (`weekly_allowance_runs`), so retries,
 * double scheduler fires, and overlapping deploys all grant exactly once —
 * the route returns how many members were granted and trusts the database,
 * not the scheduler, for correctness.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseCron(request)
  if (refused) return refused as NextResponse

  const service = createServiceClient()
  const { data: granted, error } = await service.rpc('grant_weekly_allowance')

  if (error) {
    return NextResponse.json({ error: 'The allowance run failed.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, granted })
}
