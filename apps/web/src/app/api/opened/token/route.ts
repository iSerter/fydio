import { NextResponse } from 'next/server'
import { z } from 'zod'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Mint a return token for an entry (T08).
 *
 * WHY THIS EXISTS. `OpenOriginalButton` mints its token in the browser as a side
 * effect of a click it must never block on, so the token lands in the tab's
 * `sessionStorage` and nowhere else. That is the right shape for a real member —
 * the token is theirs, held by their tab, never in a URL somebody could copy.
 *
 * It is also awkward to observe from a test, and there is one more honest consumer
 * worth having: a client that wants to prepare the return link BEFORE the member
 * clicks (T10's extension, which cannot read sessionStorage). Both cases want the
 * same thing, and neither wants a token for somebody else's open.
 *
 * SO THE ROUTE RECORDS A CLICK. It is not a token factory that skips the recording —
 * `record_outbound_click` writes the `outbound_clicks` row and marks `opened`, and
 * this route calls it exactly as the browser does. A token with no click behind it
 * would be a token that resolves to nothing, which is precisely the shape the
 * pgTAP suite proves is harmless; there is no reason to hand one out on purpose.
 *
 * `entryId` and nothing else. No user id, because the caller is `auth.uid()` inside
 * the RPC — a token can only ever be minted for the member asking.
 */
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ entryId: z.uuid('That entry id is not valid.') })

export async function POST(request: Request): Promise<NextResponse> {
  await requireUserId()

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'That entry id is not valid.' }, { status: 400 })
  }

  const supabase = await memberClient()

  const { data, error } = await supabase.rpc('record_outbound_click', {
    p_entry_id: parsed.data.entryId,
    p_client: 'web',
    p_source: 'feed',
  })

  if (error !== null) {
    // The RPC refuses an unknown or non-active entry with `no_data_found`. Mapped to
    // 404 rather than a 500 because it is a bad request, not a broken server — and
    // because the message names the entry rather than the table.
    if (error.code === 'P0002') {
      return NextResponse.json({ error: 'That entry does not exist.' }, { status: 404 })
    }

    console.error('record_outbound_click failed', error.message)

    return NextResponse.json({ error: 'That could not be recorded.' }, { status: 500 })
  }

  const [row] = data
  const token = row?.return_token

  if (typeof token !== 'string') {
    // A successful RPC with no token would mean the function changed shape under
    // this route. Failing loudly beats handing the client a link that resolves to
    // nothing.
    return NextResponse.json({ error: 'That could not be recorded.' }, { status: 500 })
  }

  return NextResponse.json({ token }, { status: 201 })
}
