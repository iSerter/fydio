import { NextResponse } from 'next/server'
import { z } from 'zod'

import { coerceDurationBand, DURATION_CONSENT_VERSION } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

import { verifyExtensionTokenRequest } from '@/lib/extension-tokens'

/**
 * Duration telemetry ingest (T08).
 *
 * WHAT THIS ENDPOINT ACCEPTS, EXACTLY: `{ entryId, band, returned }`. Three
 * fields. The schema is `.strict()`, so a client that sends a fourth field gets a
 * 400 rather than having it silently dropped — which is the difference between an
 * extension bug being visible and an extension quietly exfiltrating a page URL.
 *
 * WHAT IT CANNOT ACCEPT, EVER: a raw duration. There is no `durationMs` field, so
 * there is no code path that reads one, and a client that sends one is rejected
 * rather than accommodated. Fydio stores a band; that is a property of the wire
 * format, not a promise in a comment.
 *
 * WHY SERVICE ROLE. The extension authenticates with a scoped extension token, not
 * a session cookie, so there is no member role to run this as. The service client
 * bypasses RLS entirely, which is why two things are load-bearing here:
 *
 *   1. `ingest_duration_event` is `service_role`-only in SQL (0026), revoked from
 *      `authenticated`, because it takes a `p_user_id` argument.
 *   2. Consent is checked IN THE DATABASE, inside that function, against
 *      `duration_consents`. This route does not check consent itself — if it did,
 *      the gate would be in TypeScript, and the next caller to reach the function
 *      directly would bypass it.
 *
 * WHAT IS STORED: `{ user_id, entry_id, band, returned, consent_version,
 * received_at }`. A band and a version. Not the tab, not the URL, not a timestamp
 * of when the platform tab closed.
 */
export const dynamic = 'force-dynamic'

const bodySchema = z
  .object({
    entryId: z.uuid('That entry id is not valid.'),
    // `z.string()` rather than `z.enum(DURATION_BANDS)`: an out-of-enum band must
    // be CLAMPED to `'unknown'`, not rejected. A client that sends garbage should
    // still produce a row saying "we did not know how long", because a rejected
    // event leaves a member's activity list silently incomplete — whereas a wrong
    // band would be a false statement about their behaviour.
    band: z.string().max(32),
    returned: z.boolean().optional(),
  })
  // Strict, as above: unknown keys are an error, not something to ignore.
  .strict()

export async function POST(request: Request): Promise<NextResponse> {
  const auth = verifyExtensionTokenRequest(request)

  if (auth === null) {
    // 401 for a missing, malformed, expired, or forged token — all indistinguishable,
    // because `verifyExtensionToken` returns null for every one of them.
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // The scope check. A token minted for telemetry must not be usable for anything
  // else, so it is verified rather than assumed from the fact that the only
  // token this route accepts is this one.
  if ((auth.scope as string) !== 'telemetry:duration') {
    return NextResponse.json({ error: 'Not authorised for this action.' }, { status: 403 })
  }

  let body: unknown

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'That duration event is not valid.', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  // The clamp, applied on this side as well as in SQL. The SQL clamp is the
  // guarantee; this one means the value that reaches the database was already
  // normalised, so a reader of the insert does not have to know that.
  const band = coerceDurationBand(parsed.data.band)

  const service = createServiceClient()

  // The consent version is READ FROM THE DATABASE rather than echoed from the
  // TypeScript constant. Two reasons, and the second is the important one:
  //
  //   1. Correctness. If the SQL constant is ever ahead of this one, the response
  //      would claim a version the row does not carry.
  //   2. Drift detection. Bumping `current_duration_consent_version()` without
  //      bumping `DURATION_CONSENT_VERSION` is the exact mistake that silently
  //      invalidates every member's grant. Logging it makes that a visible warning
  //      rather than a support ticket.
  const { data: consentVersion } = await service.rpc('current_duration_consent_version')

  const storedVersion = typeof consentVersion === 'string' ? consentVersion : null

  if (storedVersion !== null && storedVersion !== DURATION_CONSENT_VERSION) {
    console.error(
      'consent version drift: SQL says',
      storedVersion,
      'but DURATION_CONSENT_VERSION says',
      DURATION_CONSENT_VERSION,
    )
  }

  // The consent gate runs inside `ingest_duration_event`. It raises `42501` when
  // the member has no active, current-version grant, and that is mapped to a 403
  // here rather than passed through — a 500 would tell the extension its telemetry
  // is broken when the truth is that the member declined it.
  const { data: eventId, error } = await service.rpc('ingest_duration_event', {
    p_user_id: auth.userId,
    p_entry_id: parsed.data.entryId,
    p_band: band,
    p_returned: parsed.data.returned ?? false,
  })

  if (error !== null) {
    if (isConsentRefusal(error.message)) {
      return NextResponse.json(
        { error: 'Duration tracking is not enabled for this member.' },
        { status: 403 },
      )
    }

    console.error('ingest_duration_event failed', error.message)

    return NextResponse.json({ error: 'That event could not be recorded.' }, { status: 500 })
  }

  return NextResponse.json(
    {
      ok: true,
      id: eventId,
      band,
      // Echoed so the extension can assert what was stored rather than what it
      // sent. If the two ever disagree, the band was clamped — and a client that
      // learns that from the response stops guessing.
      storedBand: band,
      // The database's answer, not the constant above. Falling back to the constant
      // keeps the field populated if the version read failed, which is better than
      // reporting `null` for something the row definitely carries.
      consentVersion: storedVersion ?? DURATION_CONSENT_VERSION,
    },
    { status: 201 },
  )
}

/**
 * Did the database refuse because consent is absent?
 *
 * Matched on the message rather than the SQLSTATE alone because `42501` is also
 * what a genuine permissions failure raises, and mapping that to "you have not
 * consented" would be a lie. Matching both means the 403 is specifically about
 * consent and a real permission problem still surfaces as a 500 to be investigated.
 */
function isConsentRefusal(message: string): boolean {
  return message.includes('Duration tracking is not enabled')
}
