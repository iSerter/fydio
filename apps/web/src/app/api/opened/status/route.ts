import { NextResponse } from 'next/server'

import { RETURN_TOKEN_TTL_MINUTES } from '@fydio/domain'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Return-token status (T08).
 *
 * WHY THIS EXISTS. The outbound URL belongs to the platform, so it cannot carry
 * anything of ours — and we do not modify it. That leaves the Fydio tab as the only
 * place a return token can live, which means the Fydio tab has to be able to ask
 * "is the token I am holding still good?" when the member comes back. This is that
 * question.
 *
 * WHO CALLS IT. The Fydio tab, on window focus, and the extension (T10). Both hold
 * a token from `record_outbound_click`; neither can read the destination page.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not report whether the member actually
 * read anything. Fydio cannot know that — the platform's page is not ours, and
 * watching it is exactly what this feature refuses to do. The answer is "this token
 * is still valid and names this entry", which is a statement about Fydio's own
 * record and nothing else.
 *
 * WHY A `GET` WITH A TOKEN IN THE QUERY STRING. It is a status read, and it is
 * called by a client that already holds the token in memory. The token is opaque
 * and short-lived, and the alternative (a POST body) would be marginally tidier
 * while making the endpoint uncacheable and awkward to call from the extension's
 * service worker. The 30-minute expiry bounds the exposure of a logged query
 * string.
 *
 * STATUS CODES. `200` with `{ valid: false }` for an unknown, foreign, or expired
 * token — the three are genuinely indistinguishable to the caller and reporting
 * them separately would turn this into a token oracle. `404` for a missing token
 * parameter, because that is a malformed request rather than a failed lookup.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  // Requires a session. An anonymous caller gets whatever the app's auth layer
  // says (a redirect or a 401), never a token verdict.
  await requireUserId()

  const token = new URL(request.url).searchParams.get('token')

  if (token === null || token.length === 0) {
    return NextResponse.json({ error: 'A token is required.' }, { status: 404 })
  }

  const supabase = await memberClient()

  const { data, error } = await supabase.rpc('validate_return_token', { p_token: token })

  if (error !== null) {
    console.error('validate_return_token failed', error.message)

    return NextResponse.json({ error: 'That token could not be checked.' }, { status: 500 })
  }

  const [row] = data

  if (row === undefined) {
    return NextResponse.json({
      valid: false,
      // The reason a member can act on. "Expired" covers unknown, someone else's,
      // and too-old, because we cannot tell them apart and should not pretend to.
      reason: 'This link has expired. Open the entry again to get a new one.',
      expiresInMinutes: RETURN_TOKEN_TTL_MINUTES,
    })
  }

  const { entry_id: entryId, returned_at: returnedAt } = row

  return NextResponse.json({
    valid: true,
    entryId: typeof entryId === 'string' ? entryId : null,
    // Whether this return was already acknowledged. The page uses it to avoid
    // re-stamping; the extension uses it to know the prompt has been shown.
    returned: typeof returnedAt === 'string' && returnedAt.length > 0,
  })
}
