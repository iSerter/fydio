import { NextResponse } from 'next/server'

import { createServiceClient } from '@fydio/supabase/service'

import { refuseCron } from '../guard'

/**
 * Held-credit sweeper trigger (T05; scheduled in T10).
 *
 * Moves `held` → `available` past `available_at`, skipping feedback that was
 * reported or removed. Releasing early is safe and the sweep is idempotent,
 * so the schedule is a liveness concern (hourly in T10), not a correctness
 * one — this route and `pnpm credits:release-held` call the same RPC.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const refused = refuseCron(request)
  if (refused) return refused as NextResponse

  const service = createServiceClient()
  const { data: released, error } = await service.rpc('release_held_credits')

  if (error) {
    return NextResponse.json({ error: 'The release run failed.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, released })
}
