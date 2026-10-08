import { NextResponse } from 'next/server'

import { normalizeInviteCode } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

import { checkInviteCodeStatus, hashInviteCode } from '@/lib/invite-code'

/**
 * Limited-use invite code redemption (T11 §5.6).
 *
 * Parallel to T03's `accept-invite`, with these distinctions:
 *   - The caller supplies an email address (the link is not pre-addressed)
 *   - An atomic counter enforces `used_count <= max_uses` inside `claim_invite_code`
 *   - A code can NEVER grant an admin role
 *
 * ORDER OF OPERATIONS:
 *   1. normalise + shape-check the code & validate email
 *   2. pre-check the code: valid, not revoked, not expired, has available slot
 *   3. address already registered? reject with 409 before claiming to never burn a slot
 *   4. create the auth user
 *   5. claim_invite_code -- atomic cap check and 1-code-per-user enforcement
 *   6. issue a one-time session so the member lands in onboarding
 */

export const dynamic = 'force-dynamic'

interface AcceptInviteCodeBody {
  readonly code?: unknown
  readonly email?: unknown
}

const CLAIM_ERRORS: Record<string, { status: number; message: string }> = {
  P0002: { status: 404, message: 'That invite link is not valid.' },
  '23514': { status: 410, message: 'That invite link has expired or been revoked.' },
  '23505': { status: 410, message: 'Everyone this link was shared with has already joined.' },
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: AcceptInviteCodeBody

  try {
    body = (await request.json()) as AcceptInviteCodeBody
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const rawCode = typeof body.code === 'string' ? body.code.trim() : ''
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''

  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  let normalizedCode: string
  try {
    normalizedCode = normalizeInviteCode(rawCode)
  } catch {
    return NextResponse.json({ error: 'That invite link is not valid.' }, { status: 400 })
  }

  if (normalizedCode.length < 16 || normalizedCode.length > 32) {
    return NextResponse.json({ error: 'That invite link is not valid.' }, { status: 400 })
  }

  const admin = createServiceClient()

  // Step 2: Early status check
  const statusResult = await checkInviteCodeStatus(normalizedCode)
  if (statusResult.status === 'invalid') {
    return NextResponse.json({ error: 'That invite link is not valid.' }, { status: 404 })
  }
  if (statusResult.status === 'expired' || statusResult.status === 'revoked') {
    return NextResponse.json({ error: 'That invite link has expired or been revoked.' }, { status: 410 })
  }
  if (statusResult.status === 'exhausted') {
    return NextResponse.json(
      { error: 'Everyone this link was shared with has already joined.' },
      { status: 410 },
    )
  }

  const digest = hashInviteCode(normalizedCode)

  // Step 3 & 4: Create the auth user.
  // Done before claiming so an already-registered email fails without burning a slot.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: rawEmail,
    email_confirm: true,
  })

  if (createError) {
    const alreadyExists = /already|registered|exists/i.test(createError.message)
    return NextResponse.json(
      {
        error: alreadyExists
          ? 'That address already has a Fydio account.'
          : 'Could not create your account. Please try again.',
      },
      { status: alreadyExists ? 409 : 500 },
    )
  }

  const userId = created.user.id

  // Step 5: Atomic claim inside PostgreSQL
  const { error: claimError } = await admin.rpc('claim_invite_code', {
    p_code_hash: digest,
    p_user_id: userId,
  })

  if (claimError) {
    // Rollback the newly created auth user so no orphan account remains
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId)
    if (cleanupError) {
      console.error('[fydio] invite code claim failed and orphan user could not be deleted', {
        userId,
        claimError: claimError.message,
        cleanupError: cleanupError.message,
      })
    }

    const mapped = CLAIM_ERRORS[claimError.code]
    return NextResponse.json(
      { error: mapped?.message ?? 'That invite link could not be redeemed.' },
      { status: mapped?.status ?? 500 },
    )
  }

  // Step 6: Issue a magic link session so the member lands signed in
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: rawEmail,
  })

  if (linkError) {
    return NextResponse.json({ ok: true, signedIn: false, redirectTo: '/login' })
  }

  return NextResponse.json({
    ok: true,
    signedIn: true,
    sessionToken: link.properties.hashed_token,
    redirectTo: '/onboarding',
  })
}
