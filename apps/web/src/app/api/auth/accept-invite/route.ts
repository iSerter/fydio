import { NextResponse } from 'next/server'

import { createServiceClient } from '@fydio/supabase/service'

import { hashInviteToken, inviteTokenHashParam } from '@/lib/invite-token'

/**
 * Invite redemption (T03).
 *
 * This is the ONLY route in the application that can create an account, and it is the
 * reason the invite gate is a security property rather than a UI convention.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE DESIGN, so it is spelled out:
 *
 *   1. hash the token (the raw value never reaches the database or a log)
 *   2. look the invite up by digest to learn WHICH EMAIL this token belongs to
 *   3. create the auth user for that address
 *   4. claim the invite, which is the atomic single-use check
 *   5. issue a one-time session so the member lands signed in
 *
 * Step 2 before step 3 because the TOKEN, not the caller, determines the address: a member
 * redeeming a link cannot choose who they become.
 *
 * WHY STEP 4 CAN FAIL AFTER STEP 3 SUCCEEDED. `createUser` and `claim_invite` are separate
 * systems (GoTrue and Postgres) with no shared transaction, so a crash between them would
 * leave an account with an unclaimed invite. The account is deleted in that case, because an
 * orphan account would hold the member's email address with no way to reclaim it -- they
 * would be locked out of an address they had already proven they control.
 *
 * WHY THE SERVICE ROLE, AND WHY THAT IS SAFE HERE. `createUser` bypasses RLS, so this route
 * must hold the service key. It is safe because the authority to create is the TOKEN, not
 * the caller: `claim_invite` re-checks validity, revocation, expiry and single-use inside
 * the database, and is granted to `service_role` only (0012), so no client can reach it.
 */

/** Never cache: the response carries a session. */
export const dynamic = 'force-dynamic'

interface AcceptInviteBody {
  readonly token?: unknown
}

/**
 * SQLSTATEs `claim_invite` raises, mapped to what the page should say.
 *
 * Keyed by code rather than message text so the mapping survives a wording change in the
 * function. `P0002` covers both "no such token" and a NULL user id, which are the same
 * answer to the member: this link does not work.
 */
const CLAIM_ERRORS: Record<string, { status: number; message: string }> = {
  P0002: { status: 404, message: 'That invitation link is not valid.' },
  '23514': { status: 410, message: 'That invitation has expired or was revoked.' },
  '23505': { status: 409, message: 'That invitation has already been used.' },
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: AcceptInviteBody

  try {
    body = (await request.json()) as AcceptInviteBody
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const token = typeof body.token === 'string' ? body.token.trim() : ''

  // Shape check before anything else. `generateInviteToken` emits 64 hex characters;
  // rejecting other shapes here means a mangled link never reaches the database.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ error: 'That invitation link is not valid.' }, { status: 400 })
  }

  const admin = createServiceClient()
  const digest = hashInviteToken(token)

  // Step 2: which address does this token belong to?
  //
  // Read with the service role because `invites_read_own` (0009) only lets a member see
  // their own invitation -- and the member calling this has no session yet.
  //
  // `token_hash` is `bytea`, so the comparison value carries the `\x` hex prefix. Without it
  // PostgREST compares the digest as TEXT, matches nothing, and every redemption reports
  // "Invalid invite" with no error to explain why.
  const { data: invite, error: lookupError } = await admin
    .from('invites')
    .select('id, email, accepted_at, revoked_at, expires_at')
    .eq('token_hash', inviteTokenHashParam(token))
    .maybeSingle()

  if (lookupError) {
    // Surfaced as a generic 500 rather than verbatim: this is a server fault, not a member
    // mistake, and the raw PostgREST message would describe the schema to a stranger.
    return NextResponse.json(
      { error: 'Could not verify that invitation. Please try again.' },
      { status: 500 },
    )
  }

  if (invite === null) {
    return NextResponse.json({ error: 'That invitation link is not valid.' }, { status: 404 })
  }

  // Step 4 (early checks). `claim_invite` below is the authoritative check, but refusing the
  // obvious cases here gives a better message than the RPC's generic ones and, more
  // importantly, avoids creating an account we would immediately have to delete.
  const early = rejectUnusableInvite(invite)

  if (early !== null) return early

  const email = invite.email

  // Step 3: create the account.
  //
  // `email_confirm: true` because the invitation link already proved control of the mailbox
  // far more strongly than a confirmation click would, and requiring a second email would
  // break the "one link, one account" promise. Handle and display name are left to the
  // wizard; `handle_new_user` provisions a placeholder that onboarding replaces.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  })

  // The Supabase admin client's contract is that `error` is non-null exactly when `data` is
  // unusable, so the error is the single branch point. Checking `data` as well would be a
  // second test of the same fact, and the generated types (which model `data` as always
  // present) make such a check a type error rather than a safety net.
  if (createError) {
    // The common cause is an address that already has an account -- the replay case in a
    // different guise -- reported as such rather than as a fault.
    const alreadyExists = /already|registered|exists/i.test(createError.message)

    return NextResponse.json(
      {
        error: alreadyExists
          ? 'An account already exists for that invitation. Try signing in instead.'
          : 'Could not create your account. Please try again.',
      },
      { status: alreadyExists ? 409 : 500 },
    )
  }

  const userId = created.user.id

  // Step 4 (the claim itself).
  const { error: claimError } = await admin.rpc('claim_invite', {
    p_token_hash: digest,
    p_user_id: userId,
  })

  if (claimError) {
    // Roll the account back. See the header: an orphan account holding a proven email
    // address is worse than a failed redemption, because the member can never reclaim it.
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId)

    if (cleanupError) {
      // Not swallowed silently -- an operator needs to know a partial redemption exists.
      console.error('[fydio] invite claim failed and the new account could not be removed', {
        userId,
        claimError: claimError.message,
        cleanupError: cleanupError.message,
      })
    }

    const mapped = CLAIM_ERRORS[claimError.code]

    return NextResponse.json(
      { error: mapped?.message ?? 'That invitation could not be redeemed.' },
      { status: mapped?.status ?? 500 },
    )
  }

  // Step 5: a session, so the member lands in onboarding already signed in.
  //
  // `generateLink` rather than `signInWithPassword`: it produces a single-use link token
  // exchanged by the browser's Supabase client. No password is ever created for an invited
  // member -- they have a magic link and nothing else, which is also why this codebase
  // contains no credential-collection path at all.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })

  if (linkError) {
    // The invite IS claimed and the account EXISTS at this point. Sending the member to
    // /login is the correct recovery: their account is fine, they just need the link. The
    // alternative -- reporting failure -- would push them to request an invite they have
    // already spent.
    return NextResponse.json({ ok: true, signedIn: false, redirectTo: '/login' })
  }

  return NextResponse.json({
    ok: true,
    signedIn: true,
    // The hashed token travels in the URL FRAGMENT, which browsers do not send to servers
    // and do not include in `Referer`. That is what makes it safe to hand a credential
    // through a redirect at all.
    sessionToken: link.properties.hashed_token,
    redirectTo: '/onboarding',
  })
}

interface InviteRow {
  readonly accepted_at: string | null
  readonly revoked_at: string | null
  readonly expires_at: string | null
}

/**
 * Refuse an invite that is obviously spent, revoked or stale.
 *
 * Returns a response to send, or `null` to continue. A convenience layer over
 * `claim_invite`, which remains the authority -- these checks exist so the common failures
 * produce a specific message and, for the already-used case, so no account is created first.
 */
function rejectUnusableInvite(invite: InviteRow): NextResponse | null {
  if (invite.accepted_at !== null) {
    return NextResponse.json({ error: 'That invitation has already been used.' }, { status: 409 })
  }

  if (invite.revoked_at !== null) {
    return NextResponse.json({ error: 'That invitation was revoked.' }, { status: 410 })
  }

  if (invite.expires_at !== null && new Date(invite.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'That invitation has expired.' }, { status: 410 })
  }

  return null
}