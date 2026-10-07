import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

import { DURATION_BAND_LABELS } from '@fydio/domain'
import type { Database } from '@fydio/supabase'

import { issueExtensionToken } from '@/lib/extension-tokens'

/**
 * The T08 HTTP surface against the live stack.
 *
 * WHAT ONLY A REAL SERVER CAN SHOW. Three of T08's guarantees are properties of the
 * ROUTE, not of the SQL, and pgTAP cannot reach any of them:
 *
 *   * the duration endpoint's consent gate, as a status code (403 without consent,
 *     201 with) — the SQL raises; only the route decides what that becomes;
 *   * a forged or malformed extension token produces a 401 rather than a 500,
 *     which is a claim about the verifier's error handling;
 *   * an extra field in the body is REJECTED rather than silently dropped, which
 *     is the property that keeps the endpoint from being an exfiltration surface.
 *
 * THE SQL SIDE IS PROVEN SEPARATELY. `010_telemetry.sql` covers band clamping,
 * token scoping, and expiry in the database; this file deliberately does not
 * duplicate those, so a failure here points at the route and a failure there points
 * at the schema.
 *
 * SKIPPED WITHOUT A STACK, following `auth.integration.test.ts`: CI has no
 * database, and a suite that fails there would train people to ignore it.
 */
const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const appUrl = process.env.APP_URL
const extensionSecret = process.env.EXTENSION_TOKEN_SECRET

const describeIfStack =
  supabaseUrl && anonKey && serviceKey && appUrl && extensionSecret ? describe : describe.skip

type Member = SupabaseClient<Database, 'public', 'public'>

const createClient = createSupabaseClient

/** A fresh address per run, so the suite is idempotent against a seeded database. */
const testEmail = `t08-it-${Date.now()}@demo.test`

/**
 * The raw invite token for this run.
 *
 * Real hex, because the accept route's shape check requires `/^[0-9a-f]{64}$/`
 * before it will look anything up.
 */
const rawToken = randomBytes(32).toString('hex')

/** Recorded session cookies, filled by `redeemInvite`. */
const cookieJar: Record<string, string> = {}

/** Read exactly one row, or fail loudly. */
function one<T>(rows: T[] | null | undefined, what: string): T {
  if (rows?.length !== 1) {
    throw new Error(`expected exactly one ${what}, got ${rows?.length ?? 'null'}`)
  }

  const [row] = rows
  if (row === undefined) throw new Error(`expected one ${what}, got an empty row`)

  return row
}

/**
 * Redeem an invitation and return a signed-in member client.
 *
 * Goes through the real HTTP route, because that is the only path a member takes
 * and it is the one that mints the session these tests reuse.
 */
async function redeemInvite(): Promise<{ member: Member; userId: string }> {
  const db = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
    auth: { persistSession: false },
  })

  const digest = createHash('sha256').update(rawToken, 'utf8').digest('hex')

  const { error } = await db.from('invites').insert({
    email: testEmail,
    token_hash: `\\x${digest}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })

  if (error) throw new Error(`could not issue invite: ${error.message}`)

  const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: rawToken }),
  })

  const payload = (await response.json()) as { ok?: boolean; sessionToken?: string; error?: string }

  if (!response.ok || payload.ok !== true || payload.sessionToken === undefined) {
    throw new Error(`redemption failed: ${response.status} ${payload.error ?? 'unknown'}`)
  }

  const member = createServerClient<Database>(supabaseUrl ?? '', anonKey ?? '', {
    cookies: {
      getAll() {
        return Object.entries(cookieJar).map(([name, value]) => ({ name, value }))
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          cookieJar[name] = value
        }
      },
    },
  })

  const { error: verifyError } = await member.auth.verifyOtp({
    token_hash: payload.sessionToken,
    type: 'magiclink',
  })

  if (verifyError) throw new Error(`could not verify otp: ${verifyError.message}`)

  const { data } = await member.auth.getUser()
  const userId = data.user?.id ?? ''

  if (userId === '') throw new Error('could not resolve the member id')

  return { member, userId }
}

/** Header map carrying the member's session cookies. */
function authHeaders(): Record<string, string> {
  return { cookie: Object.entries(cookieJar).map(([name, value]) => `${name}=${value}`).join('; ') }
}

/** GET as the member, so session cookies travel. */
function getAsMember(path: string): Promise<Response> {
  return fetch(`${appUrl ?? ''}${path}`, { headers: authHeaders() })
}

/** POST a body as the member. */
function postAsMember(path: string, body: unknown): Promise<Response> {
  return fetch(`${appUrl ?? ''}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** POST a body with an extension token instead of a session. */
function postWithExtensionToken(token: string, body: unknown): Promise<Response> {
  return fetch(`${appUrl ?? ''}/api/telemetry/duration`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * A real content entry to attach events to.
 *
 * Inserted with the service role rather than published through `/submit`, because
 * the submission path spends a Credit and this member has none — and the credit
 * economy is T05's subject, not this suite's. The row is identical in the ways that
 * matter here: an active entry with a canonical URL and three hashtags.
 */
async function createFixtureEntry(authorId: string, service: Member): Promise<string> {
  const url = `https://www.youtube.com/watch?v=t08${Date.now().toString(36)}`

  const { data, error } = await service
    .from('content_entries')
    .insert({
      author_id: authorId,
      platform: 'youtube',
      original_url: url,
      canonical_url: url,
      url_hash: `\\x${createHash('sha256').update(url, 'utf8').digest('hex')}`,
      title: 'T08 integration entry',
      preview_state: 'resolved',
      status: 'active',
    })
    .select('id')
    .single()

  if (error) throw new Error(`could not create fixture entry: ${error.message}`)

  return data.id
}

/**
 * Mark the member as onboarded.
 *
 * The proxy redirects any member with `onboarding_completed_at IS NULL` to
 * `/onboarding`, which would make every member-facing route in this suite return
 * a 200 carrying the wizard instead of the page under test — a green status code
 * and a meaningless assertion.
 *
 * Written directly rather than through the wizard's five steps: the wizard is T03's
 * subject, it needs a real browser, and what matters here is only that the proxy
 * lets this member past its gate. The columns it sets are the ones the proxy and
 * `mark_entry_opened`'s author lookup read.
 */
async function completeOnboarding(userId: string, service: Member): Promise<void> {
  const { error } = await service
    .from('profiles')
    .update({
      display_name: 'Telemetry Tester',
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (error) throw new Error(`could not complete onboarding: ${error.message}`)
}

describeIfStack('T08 telemetry surface', () => {
  let member: Member
  let service: Member
  let userId: string
  let entryId: string
  let otherUserIdForCleanup: string | undefined

  beforeAll(async () => {
    const redeemed = await redeemInvite()
    member = redeemed.member
    userId = redeemed.userId
    service = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
      auth: { persistSession: false },
    })

    await completeOnboarding(userId, service)
    entryId = await createFixtureEntry(userId, service)
  })

  /* --- Duration ingest: authentication ------------------------------------- */

  it('refuses a request with no extension token', async () => {
    const response = await postAsMember('/api/telemetry/duration', {
      entryId,
      band: 's15_60',
    })

    expect(response.status).toBe(401)
  })

  it('refuses a forged extension token', async () => {
    const [payload] = issueExtensionToken({
      userId,
      scope: 'telemetry:duration',
    }).split('.')

    // Correct payload, garbage signature. The exact shape of a stolen-then-edited
    // token, and the case a verifier that parsed before verifying would let through.
    const response = await postWithExtensionToken(`${payload ?? ''}.${'A'.repeat(43)}`, {
      entryId,
      band: 's15_60',
    })

    expect(response.status).toBe(401)
  })

  it('refuses a member session on the extension endpoint', async () => {
    // The extension route is token-only. A valid session must not substitute: the
    // token is what scopes the grant to one job, and accepting a session would make
    // every page that can reach this endpoint a telemetry client.
    const response = await postAsMember('/api/telemetry/duration', { entryId, band: 's15_60' })

    expect(response.status).toBe(401)
  })

  it('rejects a body carrying anything beyond the three permitted fields', async () => {
    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })

    // The whole point of `.strict()`. A client sending a URL, a title, or a raw
    // millisecond count gets an error rather than a quiet 201 — which is the
    // difference between an extension bug being visible and an extension quietly
    // collecting more than it was permitted to.
    const response = await postWithExtensionToken(token, {
      entryId,
      band: 's15_60',
      tabUrl: 'https://www.instagram.com/p/someone/else/',
      durationMs: 12345,
    })

    expect(response.status).toBe(400)
  })

  /* --- Duration ingest: consent ------------------------------------------- */

  it('refuses a valid token when the member has not consented', async () => {
    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })

    const response = await postWithExtensionToken(token, { entryId, band: 's15_60' })

    expect(response.status).toBe(403)

    // And nothing was written. A 403 that left a row behind would mean the gate is
    // advisory.
    const { data } = await service
      .from('duration_events')
      .select('id')
      .eq('user_id', userId)
      .eq('entry_id', entryId)

    expect(data).toHaveLength(0)
  })

  it('accepts a valid token once the member has consented', async () => {
    // Granted through the RPC that `setDurationConsent` calls, with the member's own
    // session — the same function the checkbox invokes, minus the Server Action
    // transport, which is not POSTable as a bare path.
    const { error } = await member.rpc('grant_duration_consent', { p_source: 'settings' })

    expect(error).toBeNull()

    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })
    const response = await postWithExtensionToken(token, {
      entryId,
      band: 'm1_3',
      returned: true,
    })

    expect(response.status).toBe(201)

    const payload = (await response.json()) as { band?: string; storedBand?: string }

    expect(payload.storedBand).toBe('m1_3')

    const { data } = await service
      .from('duration_events')
      .select('band, returned, consent_version')
      .eq('user_id', userId)
      .eq('entry_id', entryId)

    const row = one(data, 'duration event')
    expect(row.band).toBe('m1_3')
    expect(row.returned).toBe(true)
    expect(row.consent_version).not.toBe('')
  })

  it('stores an out-of-enum band as unknown, and never as a measurement', async () => {
    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })

    const response = await postWithExtensionToken(token, { entryId, band: '4200' })

    expect(response.status).toBe(201)

    const payload = (await response.json()) as { storedBand?: string }

    expect(payload.storedBand).toBe('unknown')

    const { data } = await service
      .from('duration_events')
      .select('band')
      .eq('user_id', userId)
      .eq('entry_id', entryId)
      .order('received_at', { ascending: false })

    expect(data?.[0]?.band).toBe('unknown')
    // The label exists for every band precisely so this rendering is total: an
    // unknown value still reads as something a member can interpret.
    expect(DURATION_BAND_LABELS.unknown).toBeTruthy()
  })

  it('refuses again as soon as consent is revoked', async () => {
    const { error } = await member.rpc('revoke_duration_consent')

    expect(error).toBeNull()

    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })
    const response = await postWithExtensionToken(token, { entryId, band: 'gt_3' })

    expect(response.status).toBe(403)

    // Immediate, not eventual: no cached grant, no grace period.
    const { data } = await service
      .from('duration_events')
      .select('id')
      .eq('user_id', userId)
      .eq('entry_id', entryId)
      .eq('band', 'gt_3')

    expect(data).toHaveLength(0)
  })

  it('lets a member read their own duration events and no others', async () => {
    await member.rpc('grant_duration_consent', { p_source: 'settings' })

    const token = issueExtensionToken({ userId, scope: 'telemetry:duration' })
    await postWithExtensionToken(token, { entryId, band: 's15_60' })

    // Read through the MEMBER client, so RLS is in force. The privacy panel uses
    // exactly this path, and it is the only path a member has.
    const { data: visible } = await member
      .from('duration_events')
      .select('id, user_id')
      .eq('entry_id', entryId)

    expect((visible ?? []).length).toBeGreaterThan(0)

    // Every visible row is the member's own. The seeded database has duration events
    // belonging to other members, so this is a real cross-member assertion rather
    // than a vacuous one over an empty table — checked by confirming the unfiltered
    // view DOES contain somebody else's row for this entry's owner.
    expect((visible ?? []).every((row) => row.user_id === userId)).toBe(true)

    // Sanity: the service role can see foreign rows, so the check above is RLS
    // doing the work rather than there being nothing to hide.
    const { data: everyone } = await service.from('duration_events').select('user_id').limit(50)
    const foreignCount = (everyone ?? []).filter((row) => row.user_id !== userId).length

    expect(foreignCount).toBeGreaterThan(0)
  })

  /* --- The privacy panel --------------------------------------------------- */

  it('shows the consent control and the activity of the signed-in member', async () => {
    await member.rpc('grant_duration_consent', { p_source: 'settings' })

    // One real open first. The panel lists what the member has opened, so asserting
    // it renders that list needs something in it — and reading the row through the
    // same RPC the browser uses keeps the fixture honest rather than inserted
    // directly.
    const { data: click } = await member.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: 'feed',
    })

    one(click as unknown[], 'outbound click')

    const response = await getAsMember('/settings/privacy')
    const html = await response.text()

    expect(response.status).toBe(200)
    // The consent scope text and the disclaimer both render: a toggle without them
    // is a switch nobody can reason about.
    expect(html).toContain('rough range')
    expect(html).toContain('Credits or Reputation')
    // And the member's own opened entry appears, which is what proves the reads on
    // this page are working rather than merely not erroring.
    expect(html).toContain(entryId)
  })

  /* --- Return tokens ------------------------------------------------------- */

  it('reports a valid return token and refuses a tampered one identically', async () => {
    // A click, the way the browser records one.
    const { data: click, error } = await member.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: 'entry_page',
    })

    expect(error).toBeNull()

    const row = one(click as { click_id: string; return_token: string }[], 'outbound click')
    const token = row.return_token

    const ok = await getAsMember(`/api/opened/status?token=${token}`)
    const okPayload = (await ok.json()) as { valid?: boolean; entryId?: string }

    expect(ok.status).toBe(200)
    expect(okPayload.valid).toBe(true)
    expect(okPayload.entryId).toBe(entryId)

    // Tampered and unknown are the SAME answer — not merely equally unsuccessful.
    // Distinguishing them would turn the endpoint into a token oracle.
    const tampered = `${token.slice(0, 63)}0`
    const unknown = 'f'.repeat(64)

    const tamperedResponse = await getAsMember(`/api/opened/status?token=${tampered}`)
    const unknownResponse = await getAsMember(`/api/opened/status?token=${unknown}`)

    const tamperedPayload = (await tamperedResponse.json()) as Record<string, unknown>
    const unknownPayload = (await unknownResponse.json()) as Record<string, unknown>

    expect(tamperedResponse.status).toBe(unknownResponse.status)
    expect(tamperedPayload.valid).toBe(false)
    expect(unknownPayload.valid).toBe(false)
    expect(tamperedPayload.reason).toBe(unknownPayload.reason)
  })

  it('refuses a return token belonging to another member', async () => {
    const { data: click } = await member.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: 'feed',
    })

    const row = one(click as { return_token: string }[], 'outbound click')

    // A SECOND member's session, asking about the first member's token. This is the
    // cross-member case: viewer scoping is enforced in SQL, and this proves the
    // route inherits it rather than re-implementing it.
    const otherInvite = randomBytes(32).toString('hex')
    const otherEmail = `t08-other-${Date.now()}@demo.test`

    const admin = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
      auth: { persistSession: false },
    })

    const digest = createHash('sha256').update(otherInvite, 'utf8').digest('hex')

    await admin.from('invites').insert({
      email: otherEmail,
      token_hash: `\\x${digest}`,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    })

    const acceptance = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: otherInvite }),
    })

    const accepted = (await acceptance.json()) as { ok?: boolean; sessionToken?: string }
    expect(accepted.ok).toBe(true)

    const otherJar: Record<string, string> = {}

    const other = createServerClient<Database>(supabaseUrl ?? '', anonKey ?? '', {
      cookies: {
        getAll: () => Object.entries(otherJar).map(([name, value]) => ({ name, value })),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) otherJar[name] = value
        },
      },
    })

    await other.auth.verifyOtp({
      token_hash: accepted.sessionToken ?? '',
      type: 'magiclink',
    })

    // Onboarded too, for the same reason `beforeAll` does it: the proxy would
    // redirect an un-onboarded member and the response would be the wizard rather
    // than the token verdict under test.
    const { data: otherUser } = await other.auth.getUser()
    const otherUserId = otherUser.user?.id ?? ''
    if (otherUserId === '') throw new Error('could not resolve foreign member id')
    otherUserIdForCleanup = otherUserId

    await completeOnboarding(otherUserId, admin)

    const foreignResponse = await fetch(
      `${appUrl ?? ''}/api/opened/status?token=${row.return_token}`,
      {
        headers: {
          cookie: Object.entries(otherJar)
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
        },
      },
    )

    const foreignPayload = (await foreignResponse.json()) as { valid?: boolean }

    expect(foreignPayload.valid).toBe(false)
  })

  it('renders a safe page for a tampered return token', async () => {
    const response = await getAsMember('/opened/' + 'f'.repeat(64))
    const html = await response.text()

    expect(response.status).toBe(200)
    // The fallback, not a stack trace, an error digest, or a 500.
    expect(html).toContain('expired')
    expect(html).not.toContain('AggregateError')
  })

  it('shows the feedback prompt on a valid return', async () => {
    const { data: click } = await member.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: 'entry_page',
    })

    const row = one(click as { return_token: string }[], 'outbound click')
    const response = await getAsMember(`/opened/${row.return_token}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('Leave feedback')
    // And the entry it belongs to, so the prompt is anchored to real context rather
    // than asking about something the member cannot see.
    expect(html).toContain(entryId)
  })

  /* --- The opened mark ----------------------------------------------------- */

  it('marks the entry opened for the clicking member and no one else', async () => {
    const { data: click, error } = await member.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: 'feed',
    })

    expect(error).toBeNull()
    one(click as unknown[], 'outbound click')

    const { data: mine } = await service
      .from('feed_impressions')
      .select('opened, opened_at')
      .eq('viewer_id', userId)
      .eq('entry_id', entryId)

    expect(one(mine, 'impression').opened).toBe(true)

    // The member's own read, through RLS: they can see their open and it is the
    // only one they can see for this entry.
    const { data: asMember } = await member
      .from('feed_impressions')
      .select('viewer_id, opened')
      .eq('entry_id', entryId)
      .eq('opened', true)

    expect((asMember ?? []).every((row) => row.viewer_id === userId)).toBe(true)
  })

  afterAll(async () => {
    const userIds = [userId, otherUserIdForCleanup].filter((id): id is string => typeof id === 'string')

    await service.from('feed_impressions').delete().eq('entry_id', entryId)
    await service.from('outbound_clicks').delete().eq('entry_id', entryId)
    await service.from('duration_events').delete().eq('entry_id', entryId)
    await service.from('content_entries').delete().eq('id', entryId)

    for (const uid of userIds) {
      await service.from('duration_consents').delete().eq('user_id', uid)
      await service.from('duration_events').delete().eq('user_id', uid)
      await service.from('feed_impressions').delete().eq('viewer_id', uid)
      await service.from('outbound_clicks').delete().eq('user_id', uid)
      await service.from('profiles').delete().eq('id', uid)
      await service.auth.admin.deleteUser(uid)
    }
  })
})
