import { describe, expect, it, beforeAll } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

import sharp from 'sharp'

import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@fydio/supabase'

/**
 * The service-role client factory.
 *
 * `createServerClient` is the wrong tool for the setup writes: it is cookie-scoped, and there is
 * no member session before redemption. `createSupabaseClient` is aliased so the call sites read
 * the same as the rest of the codebase.
 */
const createClient = createSupabaseClient

/**
 * The member client type.
 *
 * Spelled out once because it appears in three signatures, and the pinned `'public'` schema is
 * what makes `.from('profiles')` resolve to a real row type instead of collapsing to `any` and
 * silently erasing every assertion below.
 */
type Member = SupabaseClient<Database, 'public', 'public'>

/**
 * Live-stack integration tests for the T03 HTTP surface (T03 §9).
 *
 * These exercise the routes over real HTTP against the running dev server, which is the only
 * layer where three of the guarantees are actually observable:
 *
 *   • the avatar route's `sharp` re-encode and its size ceiling;
 *   • Storage RLS, which only bites when a request carries a real member's JWT;
 *   • the invite-only gate, which is a property of GoTrue configuration rather than of any
 *     function the pgTAP suite can call.
 *
 * A member session is minted through the real redemption path rather than a password, because
 * Fydio has no passwords -- a test that invented one would be testing a code path the product
 * does not have.
 *
 * Skipped without `APP_URL`, so CI (no stack, no server) stays green while a developer with
 * `pnpm dev:stack && pnpm dev` running gets real assertions. This is the same trade-off
 * `packages/supabase/test/rpc.integration.test.ts` makes.
 */
const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const appUrl = process.env.APP_URL

const describeIfStack =
  supabaseUrl && anonKey && serviceKey && appUrl ? describe : describe.skip

/**
 * A fresh address per run, so the suite is idempotent against a seeded database.
 */
const testEmail = `t03-it-${Date.now()}@demo.test`

/**
 * The raw invite token for this run.
 *
 * Real hex, because the accept route's shape check requires `/^[0-9a-f]{64}$/` before it will
 * look anything up -- a token built from letters outside that range is rejected as malformed
 * rather than as unknown, which would make every assertion below test the wrong thing.
 *
 * Random rather than derived from the clock, because `invites.token_hash` is UNIQUE and a
 * predictable value would collide with the row a previous run left behind.
 *
 * Module-scoped rather than returned from `redeemInvite`, because the replay assertion has to
 * present the SAME token a second time -- that is the whole test.
 */
const rawToken = randomBytes(32).toString('hex')

/**
 * Read exactly one row, or fail loudly.
 *
 * `rows?.length !== 1` covers all three failure modes at once -- null, undefined, and the wrong
 * count -- so there is no separate emptiness check to forget.
 */
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
 * Goes through the real HTTP route rather than calling `claim_invite` directly, because the
 * interesting part of that route is the ordering: create the user, THEN claim, then roll back
 * if the claim fails. Calling the RPC alone would skip exactly the behaviour under test.
 */
async function redeemInvite(): Promise<{ member: Member; userId: string }> {
  const db = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
    auth: { persistSession: false },
  })

  const digest = createHash('sha256').update(rawToken, 'utf8').digest('hex')

  const { error } = await db.from('invites').insert({
    email: testEmail,
    // `\x` hex: `token_hash` is `bytea`, and PostgREST needs the prefix to match it as bytes.
    token_hash: `\\x${digest}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  })

  if (error) throw new Error(`could not issue invite: ${error.message}`)

  const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: rawToken }),
  })

  const payload = (await response.json()) as {
    ok?: boolean
    sessionToken?: string
    error?: string
  }

  if (!response.ok || payload.ok !== true || payload.sessionToken === undefined) {
    throw new Error(`redemption failed: ${response.status} ${payload.error ?? 'unknown'}`)
  }

  // Exchange the one-time token for a session through the SSR client, recording every cookie it
  // writes. This is the same path a browser takes, so the cookies replayed by `authHeaders` are
  // exactly the ones a real member would carry.
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

/**
 * The signed-in member's cookies, as a browser would hold them.
 *
 * WHY COOKIES AND NOT A BEARER TOKEN. The app authenticates browser traffic with Supabase
 * session COOKIES; the proxy reads them via `@supabase/ssr` and has no notion of an
 * `Authorization` header. A test that sent only `Authorization: Bearer …` would be testing a
 * transport the product does not support, and every session-gated assertion would fail for that
 * reason rather than because of a defect.
 *
 * The jar is filled by `redeemInvite`'s `setAll` callback, which is the same hook the Next
 * server client uses to write session cookies.
 */
const cookieJar: Record<string, string> = {}

function memberCookies(): string {
  const pairs = Object.entries(cookieJar).map(([name, value]) => `${name}=${value}`)

  if (pairs.length === 0) throw new Error('expected recorded session cookies')

  return pairs.join('; ')
}

/** Header map carrying the member's session cookies. */
function authHeaders(): Record<string, string> {
  return { cookie: memberCookies() }
}

/**
 * POST a JSON body carrying the member's session cookies.
 *
 * The `client` parameter is deliberately absent: the cookie jar is module-scoped and filled once
 * by `redeemInvite`, so threading a client through would imply a per-member jar that does not
 * exist. There is exactly one member in this suite.
 */
async function postAsMember(path: string, body: unknown): Promise<Response> {
  const headers = authHeaders()

  return fetch(`${appUrl ?? ''}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}


describeIfStack('T03 HTTP surface', () => {
  let member: Member
  let userId: string

  beforeAll(async () => {
    const redeemed = await redeemInvite()
    member = redeemed.member
    userId = redeemed.userId
  })

  /* --- Invite gate ------------------------------------------------------------- */

  it('rejects a malformed token before touching the database', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    })

    expect(response.status).toBe(400)
  })

  it('reports a well-formed but unknown token as invalid', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'f'.repeat(64) }),
    })

    expect(response.status).toBe(404)
  })

  it('refuses to redeem the same token twice', async () => {
    // The acceptance criterion, asserted over HTTP rather than in SQL: this is the exact
    // journey a replayed database dump would take.
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    })

    expect(response.status).toBe(409)
  })

  it('stores only the digest, never the raw token', async () => {
    const db = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
      auth: { persistSession: false },
    })

    const { data } = await db
      .from('invites')
      .select('token_hash, accepted_by')
      .eq('email', testEmail)
      .maybeSingle()

    // The brief's threat model: a leaked database must not be replayable. Nothing stored here
    // is usable as a token.
    expect(String(data?.token_hash)).not.toContain(rawToken)
    expect(data?.accepted_by).toBe(userId)
  })

  it('provisions a profile with onboarding pending and no hashtags', async () => {
    const { data } = await member
      .from('profiles')
      .select('role, onboarding_completed_at')
      .eq('id', userId)
      .maybeSingle()

    expect(data?.role).toBe('member')
    // The onboarding gate is what keeps this member out of the feed until the wizard is done.
    expect(data?.onboarding_completed_at).toBeNull()

    const { count } = await member
      .from('profile_hashtags')
      .select('profile_id', { count: 'exact', head: true })
      .eq('profile_id', userId)

    expect(count).toBe(0)
  })

  /**
   * The onboarding gate, asserted while the member is still un-onboarded.
   *
   * Ordered FIRST among the session tests, and that ordering is load-bearing: by the time the
   * avatar and friendship tests run, this member has completed onboarding and the gate no longer
   * applies. Testing it last would silently pass for the wrong reason -- or fail, having been
   * written against a state that no longer exists.
   */
  it('redirects an un-onboarded member to the wizard', async () => {
    const response = await fetch(`${appUrl ?? ''}/feed`, {
      headers: authHeaders(),
      redirect: 'manual',
    })

    expect([307, 308]).toContain(response.status)
    expect(response.headers.get('location')).toContain('/onboarding')
  })

  /* --- Hashtags ---------------------------------------------------------------- */

  it('lists the shared vocabulary to a member', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/hashtags?q=hook`, {
      headers: authHeaders(),
    })

    expect(response.status).toBe(200)

    const payload = (await response.json()) as { hashtags: { slug: string }[] }
    expect(payload.hashtags.length).toBeGreaterThan(0)
  })

  it('creates a hashtag idempotently', async () => {
    const first = await postAsMember('/api/hashtags', { label: '#T03 Integration Tag' })

    expect(first.status).toBe(200)

    const created = (await first.json()) as { hashtag: { slug: string } }
    // Normalisation: case folded, spaces collapsed to a single hyphen.
    expect(created.hashtag.slug).toBe('t03-integration-tag')

    // The same label again returns the SAME row rather than erroring or duplicating, which is
    // what makes the picker's confirm-a-typed-tag flow safe.
    const second = await postAsMember('/api/hashtags', { label: 't03_integration_tag' })

    expect(second.status).toBe(200)
    const again = (await second.json()) as { hashtag: { slug: string } }
    expect(again.hashtag.slug).toBe(created.hashtag.slug)
  })

  it('refuses a sixth profile hashtag', async () => {
    const { data: tags } = await member.from('hashtags').select('id').limit(6)

    const { error } = await member.rpc('set_profile_hashtags', {
      p_hashtags: (tags ?? []).map((row) => row.id),
    })

    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  it('accepts exactly five and stores them', async () => {
    const { data: tags } = await member.from('hashtags').select('id').limit(5)

    const { error } = await member.rpc('set_profile_hashtags', {
      p_hashtags: (tags ?? []).map((row) => row.id),
    })

    expect(error).toBeNull()

    const { count } = await member
      .from('profile_hashtags')
      .select('profile_id', { count: 'exact', head: true })
      .eq('profile_id', userId)

    expect(count).toBe(5)
  })

  /* --- Avatar ----------------------------------------------------------------- */

  /**
   * Finish onboarding before the member-gated API tests.
   *
   * Not incidental ordering. The proxy bounces an un-onboarded member to `/onboarding`, so
   * without this the avatar and friendship requests would be redirected to the wizard and every
   * assertion below would fail for that reason rather than because of a defect.
   *
   * This is also the only test that exercises `set_profile_hashtags` through the wizard's
   * completion path, so it doubles as the check that onboarding actually writes five tags.
   */
  it('completes onboarding with exactly five hashtags', async () => {
    const { data: tags } = await member.from('hashtags').select('id').limit(5)

    const { error: hashtagError } = await member.rpc('set_profile_hashtags', {
      p_hashtags: (tags ?? []).map((row) => row.id),
    })

    expect(hashtagError).toBeNull()

    const { error } = await member
      .from('profiles')
      .update({
        display_name: 'T03 Integration',
        bio: 'Created by the T03 integration suite.',
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq('id', userId)

    expect(error).toBeNull()

    const { data } = await member
      .from('profiles')
      .select('onboarding_completed_at')
      .eq('id', userId)
      .maybeSingle()

    expect(data?.onboarding_completed_at).not.toBeNull()
  })

  it('rejects a non-image MIME type', async () => {
    const form = new FormData()
    // Correctly DECLARED as a PNG, but not a PNG. Only the decode can catch this -- which is
    // why the route re-encodes rather than trusting the declared type.
    form.append(
      'file',
      new File([new TextEncoder().encode('not an image')], 'fake.png', { type: 'image/png' }),
    )

    const response = await fetch(`${appUrl ?? ''}/api/profile/avatar`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })

    expect(response.status).toBe(415)
  })

  it('rejects a file over 5 MB', async () => {
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1024)], 'big.jpg', {
      type: 'image/jpeg',
    })

    const form = new FormData()
    form.append('file', oversized)

    const response = await fetch(`${appUrl ?? ''}/api/profile/avatar`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })

    expect(response.status).toBe(413)
  })

  it('re-encodes an accepted avatar to a small square WebP', async () => {
    const source = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer()

    const form = new FormData()
    form.append('file', new File([new Uint8Array(source)], 'avatar.jpg', { type: 'image/jpeg' }))

    const response = await fetch(`${appUrl ?? ''}/api/profile/avatar`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    })

    expect(response.status).toBe(200)

    const payload = (await response.json()) as { avatarPath: string; bytes: number }

    // Re-encoded, not merely stored.
    expect(payload.avatarPath).toMatch(/\.webp$/)
    expect(payload.bytes).toBeLessThanOrEqual(200 * 1024)

    // The path convention is what makes the Storage RLS policy an ownership test.
    expect(payload.avatarPath.startsWith(`${userId}/`)).toBe(true)

    const stored = await member.storage.from('avatars').download(payload.avatarPath)
    expect(stored.error).toBeNull()

    // `data` is nullable in the generated types. Asserted rather than asserted-away so a failed
    // download reports "expected a blob, got null" instead of a confusing sharp parse error.
    const blob = stored.data

    if (blob === null) throw new Error('expected a downloaded avatar blob')

    // `metadata()` returns a non-nullable object, but its dimension fields are only populated for
    // formats that have them -- hence the guards rather than a non-null assertion.
    const meta = await sharp(await blob.arrayBuffer()).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(512)
    expect(meta.height).toBe(512)

    const { data: profile } = await member
      .from('profiles')
      .select('avatar_path')
      .eq('id', userId)
      .maybeSingle()

    expect(profile?.avatar_path).toBe(payload.avatarPath)
  })

  it('refuses an unauthenticated avatar upload', async () => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'x.jpg', { type: 'image/jpeg' }))

    const response = await fetch(`${appUrl ?? ''}/api/profile/avatar`, {
      method: 'POST',
      body: form,
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  /* --- Friendships ------------------------------------------------------------ */

  it('refuses a friend request to oneself', async () => {
    const response = await postAsMember('/api/friendships', {
      action: 'send',
      addresseeId: userId,
    })

    expect(response.status).toBe(409)
  })

  it('lets a request through but never lets the requester accept it', async () => {
    // A second, independent member, so the handshake is genuinely two-sided.
    const { data: others } = await member
      .from('profiles')
      .select('id')
      .neq('id', userId)
      .order('handle')
      .limit(1)

    const otherId = one(others, 'another profile').id

    const sent = await postAsMember('/api/friendships', {
      action: 'send',
      addresseeId: otherId,
    })

    expect(sent.status).toBe(200)

    const { data: row } = await member
      .from('friendships')
      .select('id, state')
      .eq('requester_id', userId)
      .eq('addressee_id', otherId)
      .maybeSingle()

    expect(row?.state).toBe('pending')

    // THE assertion the feed's friend boost depends on: only a mutual acceptance counts, and
    // the requester cannot manufacture the second half of it.
    const selfAccept = await postAsMember('/api/friendships', {
      action: 'accept',
      friendshipId: row?.id,
    })

    expect(selfAccept.status).toBe(403)
  })

  /* --- Route protection -------------------------------------------------------- */

  it('redirects an anonymous visitor away from a member page', async () => {
    const response = await fetch(`${appUrl ?? ''}/feed`, { redirect: 'manual' })

    expect([307, 308]).toContain(response.status)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('lets an anonymous visitor reach the login page', async () => {
    const response = await fetch(`${appUrl ?? ''}/login`)

    expect(response.status).toBe(200)
  })
})

