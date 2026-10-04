import { NextResponse } from 'next/server'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Friendship actions (T03).
 *
 * One route for the whole state machine rather than one per verb, because the transitions are
 * the unit of meaning: "accept this request", "block this member" and "unfriend" are three
 * transitions on one pair, and a REST-ish split would scatter them across files while the
 * state machine stays in the database anyway.
 *
 * NO LOGIC LIVES HERE. Every branch is a call to the SECURITY DEFINER RPCs from migration
 * 0013, each of which re-checks the transition. This route translates HTTP into an RPC name
 * and maps SQLSTATEs onto status codes. That is deliberate: the alternative -- enforcing
 * "only the addressee may accept" in a route handler -- would mean the rule exists in two
 * places and the weaker one is the one a future caller will reach for.
 */

/** Never cached. */
export const dynamic = 'force-dynamic'

type Action = 'send' | 'accept' | 'decline' | 'remove' | 'block' | 'unblock'

interface FriendshipRequest {
  readonly action?: unknown
  readonly friendshipId?: unknown
  readonly addresseeId?: unknown
  readonly userId?: unknown
}

/**
 * RPC name to the arguments it takes, and the SQLSTATEs it can refuse with.
 *
 * The status mapping is per-action rather than global because the same code means different
 * things in different places: `23505` is "already used" for an invite but "already
 * connected" for a friend request, and the member needs the second wording.
 *
 * `args` returns a plain record rather than a typed RPC payload, and `call` below switches on
 * the action to keep the literal function name. That indirection is forced: the generated
 * `Database` type keys `rpc()` by the function name as a string LITERAL, so a name held in a
 * variable will not typecheck -- and casting through `as never` to force it would throw away
 * the check that a renamed or misspelled RPC is caught at compile time.
 */
const ACTIONS: Record<
  Action,
  {
    refusals: Record<string, { status: number; message: string }>
  }
> = {
  send: {
    refusals: {
      // check_violation -- self, already pending, already connected, blocked, or rate-limited.
      '23514': { status: 409, message: 'That request cannot be sent right now.' },
      // no_data_found -- the addressee does not exist.
      P0002: { status: 404, message: 'That member no longer exists.' },
    },
  },
  accept: {
    refusals: {
      '23514': { status: 409, message: 'That request has already been answered.' },
      // insufficient_privilege -- the caller is not the addressee.
      '42501': { status: 403, message: 'Only the person who received this request can answer it.' },
      P0002: { status: 404, message: 'That request no longer exists.' },
    },
  },
  decline: {
    refusals: {
      '23514': { status: 409, message: 'That request has already been answered.' },
      '42501': { status: 403, message: 'Only the person who received this request can answer it.' },
      P0002: { status: 404, message: 'That request no longer exists.' },
    },
  },
  remove: {
    refusals: {
      '23514': { status: 409, message: 'Only an accepted connection can be removed.' },
      '42501': { status: 403, message: 'That connection is not yours to remove.' },
      P0002: { status: 404, message: 'That connection no longer exists.' },
    },
  },
  block: {
    refusals: {
      '23514': { status: 400, message: 'You cannot block that member.' },
      P0002: { status: 404, message: 'That member no longer exists.' },
    },
  },
  unblock: {
    refusals: {
      '23514': { status: 409, message: 'That member is not blocked.' },
      P0002: { status: 404, message: 'That member no longer exists.' },
    },
  },
}

/**
 * Dispatch to the RPC for `action`.
 *
 * The switch is exhaustive over `Action`, so adding an action without a case is a compile
 * error rather than a runtime "unknown action".
 */
async function callRpc(
  supabase: Awaited<ReturnType<typeof memberClient>>,
  action: Action,
  id: string,
): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
  switch (action) {
    case 'send':
      return supabase.rpc('send_friend_request', { p_addressee: id })
    case 'accept':
      return supabase.rpc('respond_friend_request', { p_friendship_id: id, p_accept: true })
    case 'decline':
      return supabase.rpc('respond_friend_request', { p_friendship_id: id, p_accept: false })
    case 'remove':
      return supabase.rpc('remove_friend', { p_friendship_id: id })
    case 'block':
      return supabase.rpc('block_member', { p_user_id: id })
    case 'unblock':
      return supabase.rpc('unblock_member', { p_user_id: id })
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Refuses the request outright when there is no session. Every RPC below also reads
  // `auth.uid()`, so this is belt-and-braces -- but a 401 from here is a clearer answer than
  // the RPC's "Authentication required".
  await requireUserId()

  let body: FriendshipRequest

  try {
    body = (await request.json()) as FriendshipRequest
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  if (!isAction(body.action)) {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  const action = ACTIONS[body.action]

  // `send`/`block`/`unblock` address a member; the others address a specific request.
  const addressed =
    body.action === 'send' || body.action === 'block' || body.action === 'unblock'
      ? asUuid(body.userId ?? body.addresseeId)
      : asUuid(body.friendshipId)

  if (addressed === null) {
    return NextResponse.json({ error: 'Missing or malformed id.' }, { status: 400 })
  }

  const supabase = await memberClient()
  const { data, error } = await callRpc(supabase, body.action, addressed)

  if (error) {
    const mapped = action.refusals[error.code]

    return NextResponse.json(
      { error: mapped?.message ?? 'That action could not be completed.' },
      { status: mapped?.status ?? 500 },
    )
  }

  return NextResponse.json({ ok: true, friendship: data })
}

/**
 * Read the caller's confirmed friends, or the single pair with `?userId=`.
 *
 * `GET /api/friendships` returns accepted connections; with a `userId` it returns the state
 * of that one pair, which is what `FriendRequestButton` needs to decide which action to
 * offer.
 *
 * The read runs as the member, so RLS's `friendships_read_involved` applies: a member can
 * only ever see pairs they are part of, and a `userId` belonging to somebody else yields an
 * empty list rather than someone else's connections.
 */
export async function GET(request: Request): Promise<NextResponse> {
  await requireUserId()

  const url = new URL(request.url)
  const userId = asUuid(url.searchParams.get('userId'))
  const supabase = await memberClient()

  let query = supabase
    .from('friendships')
    .select(
      'id, requester_id, addressee_id, state, created_at, responded_at',
    )
    .eq('state', 'accepted')

  if (userId !== null) {
    // `or` rather than two `eq` calls: PostgREST ANDs repeated filters, so expressing
    // "this member is one end of the pair" needs a single `or`.
    query = query.or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: 'Could not load friendships.' }, { status: 500 })
  }

  return NextResponse.json({ friendships: data })
}
function isAction(value: unknown): value is Action {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value)
}

/**
 * A UUID as a string, or `null`.
 *
 * Validated here as well as in the database so a malformed id produces a 400 rather than a
 * 22P02 from Postgres. The database check is the real one; this only saves a round trip.
 */
function asUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
}