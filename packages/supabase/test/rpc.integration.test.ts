import { describe, expect, it, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '../src/types.generated.js'

/**
 * Live-stack integration tests (T02 §9).
 *
 * These round-trip real RPCs over HTTP against the seeded database, which is the only
 * layer where three of the guarantees can actually be observed:
 *
 *  • the advisory lock that makes a spend atomic needs two genuinely concurrent
 *    requests — pgTAP is single-connection, and `dblink` needs a superuser this stack
 *    does not grant;
 *  • PostgREST surfaces SQLSTATEs to the client, so the error codes the UI will branch
 *    on are asserted rather than assumed;
 *  • a real member session proves RLS and the RPCs agree, which a service-role test
 *    cannot (it bypasses both).
 *
 * THE SERVICE ROLE IS NOT A MEMBER. `service_role` has no `auth.uid()`, so every
 * member-facing RPC answers "Authentication required" when called with it — correct
 * behaviour, and the reason these tests sign in as a seeded demo account instead.
 *
 * Skipped without `SUPABASE_URL`, so CI (no stack) stays green while a developer with
 * the stack up gets real assertions.
 */
const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const describeIfStack = supabaseUrl && anonKey && serviceKey ? describe : describe.skip

/** The local-only password every seeded account shares. See supabase/seed.sql. */
const DEMO_PASSWORD = 'demo-password-not-real'

/** Password for accounts this suite creates and deletes itself. */
const FIXTURE_PASSWORD = 'integration-test-password'

/**
 * Read exactly one row, or fail loudly.
 *
 * Written with real control flow rather than a non-null assertion because the repo
 * forbids `!` — and because a helper that throws gives a better failure than one that
 * returns `undefined` three frames later.
 */
function one<T>(rows: T[] | null | undefined, what: string): T {
  if (rows === null || rows === undefined) {
    throw new Error(`expected ${what}, got no rows`)
  }
  if (rows.length !== 1) {
    throw new Error(`expected exactly one ${what}, got ${rows.length}`)
  }
  const [row] = rows
  if (row === undefined) {
    throw new Error(`expected ${what}, got an empty row`)
  }
  return row
}

/**
 * The env values, narrowed once.
 *
 * `describeIfStack` already guarantees these are present, but the compiler does not,
 * and the repo forbids `!`. Reading them through this helper keeps the assertion in
 * one place instead of at every call site.
 */
function env(): { url: string; anonKey: string; serviceKey: string } {
  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required')
  }
  return { url: supabaseUrl, anonKey, serviceKey }
}

/**
 * Narrow a `jsonb` result to a record.
 *
 * The RPC returns `jsonb`, which the generated types surface as the `Json` union, so
 * its properties cannot be read until it is known to be an object. A runtime check
 * rather than a cast, because a shape change in the function should fail the test
 * instead of the assertion quietly reading `undefined`.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a jsonb object, got ${JSON.stringify(value)}`)
  }
  return value as Record<string, unknown>
}

/** The signed-in user id, or a thrown error. */
function userIdOf(user: { id: string } | null | undefined): string {
  if (user === null || user === undefined) {
    throw new Error('expected a signed-in user')
  }
  return user.id
}

/**
 * Create a throwaway member and sign in as them.
 *
 * Takes the service client as a parameter rather than closing over it: this helper
 * lives at module scope, where the suite's `db` binding does not exist.
 */
async function createMember(
  db: SupabaseClient<Database>,
): Promise<{ id: string; client: SupabaseClient<Database> }> {
  const email = `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@demo.test`

  const { data, error } = await db.auth.admin.createUser({
    email,
    password: FIXTURE_PASSWORD,
    email_confirm: true,
  })
  expect(error).toBeNull()

  const client = await signIn(email, FIXTURE_PASSWORD)
  return { id: userIdOf(data.user), client }
}

/** Assert a Supabase error carries a specific Postgres SQLSTATE. */
function expectSqlstate(error: { code?: string } | null, sqlstate: string): void {
  expect(error, 'expected an error but the call succeeded').not.toBeNull()
  // PostgREST returns the SQLSTATE verbatim in `code` for a raised exception.
  expect(error?.code, `expected SQLSTATE ${sqlstate}`).toBe(sqlstate)
}

/** A client signed in as a real member, so RLS and `auth.uid()` both apply. */
async function signIn(
  email: string,
  password: string = DEMO_PASSWORD,
): Promise<SupabaseClient<Database>> {
  const client = createClient(env().url, env().anonKey, {
    db: { schema: 'public' },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data, error } = await client.auth.signInWithPassword({ email, password })
  expect(error, `could not sign in as ${email}: ${error?.message}`).toBeNull()
  expect(data.user).not.toBeNull()

  return client
}

describeIfStack('T02 RPCs against the seeded stack', () => {
  let db: SupabaseClient<Database>
  let tagIds: string[]
  let adminId: string

  beforeAll(async () => {
    db = createClient(env().url, env().serviceKey, {
      db: { schema: 'public' },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const { data: tags } = await db.from('hashtags').select('id').limit(3)
    tagIds = (tags ?? []).map((t) => t.id)
    expect(tagIds).toHaveLength(3)

    const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin')
    adminId = one(admins, 'the seeded admin').id
  })

  /* --- The seed itself ---------------------------------------------------------- */

  it('seeds a coherent community', async () => {
    const { data: profiles, error } = await db.from('profiles').select('id, role')
    expect(error).toBeNull()

    // Counted from the seed's own pattern rather than hard-coded to 30: this suite
    // creates and deletes throwaway members, and a shared Vitest worker can overlap
    // runs, so an absolute count here would be flaky for reasons unrelated to the
    // schema.
    const seeded = (profiles ?? []).filter((p) => p.id.startsWith('00000000-'))
    expect(seeded).toHaveLength(30)
    expect(seeded.filter((p) => p.role === 'admin')).toHaveLength(1)
  })

  it('gives every profile exactly five hashtags and every entry exactly three', async () => {
    // Scoped to the seeded cohort: the fixed-id range the seed uses. Throwaway members
    // this suite creates are created after the seed and carry no hashtags by design, so
    // including them would test the fixture rather than the seed.
    const [{ data: profiles }, { data: entries }] = await Promise.all([
      db.from('profiles').select('id').like('id', '00000000-%'),
      db.from('content_entries').select('id'),
    ])

    for (const { id } of profiles ?? []) {
      const { count } = await db
        .from('profile_hashtags')
        .select('*', { count: 'exact', head: true })
        .eq('profile_id', id)
      expect(count, `profile ${id} should have 5 hashtags`).toBe(5)
    }

    for (const { id } of entries ?? []) {
      const { count } = await db
        .from('content_hashtags')
        .select('*', { count: 'exact', head: true })
        .eq('content_entry_id', id)
      expect(count, `entry ${id} should have 3 hashtags`).toBe(3)
    }
  })

  /* --- Identity ------------------------------------------------------------------ */

  it('provisions a profile on sign-up via the auth trigger', async () => {
    const email = `signup-${Date.now()}@demo.test`

    const { data, error } = await db.auth.admin.createUser({
      email,
      password: FIXTURE_PASSWORD,
      email_confirm: true,
    })
    expect(error).toBeNull()

    // The trigger on auth.users creates this row — not the client.
    const { data: profile } = await db
      .from('profiles')
      .select('id, handle')
      .eq('id', userIdOf(data.user))
      .single()

    if (profile === null) {
      throw new Error('the auth trigger did not create a profile')
    }

    expect(profile.handle).toMatch(/^[a-z0-9_]{3,30}$/)

    await db.auth.admin.deleteUser(userIdOf(data.user))
  })

  /* --- The atomic spend ---------------------------------------------------------- */

  it('refuses a submission when the balance is too low', async () => {
    // A throwaway member with an empty ledger, signed in for real.
    const { id: userId, client: member } = await createMember(db)

    const { data: balance } = await member.rpc('get_credit_balance', { p_user_id: userId })
    expect(balance).toBe(0)

    const { error } = await member.rpc('create_content_entry', {
      p_platform: 'youtube',
      p_url: 'https://integration.test/broke',
      p_canonical_url: 'https://integration.test/broke',
      p_hashtags: tagIds,
    })

    // check_violation is the code the "Insufficient Credits" guard raises.
    expectSqlstate(error, '23514')
    expect(error?.message).toContain('Insufficient Credits')

    await db.auth.admin.deleteUser(userId)
  })

  it('spends exactly one credit per submission', async () => {
    const { id: userId, client: member } = await createMember(db)

    await db.from('credit_ledger').insert({
      user_id: userId,
      delta: 5,
      kind: 'admin_grant',
      status: 'available',
      note: 'integration fixture',
    })

    const url = `https://integration.test/${Date.now()}`
    const { data: entry, error } = await member.rpc('create_content_entry', {
      p_platform: 'youtube',
      p_url: url,
      p_canonical_url: url,
      p_hashtags: tagIds,
    })

    expect(error).toBeNull()
    expect(entry).toMatchObject({ platform: 'youtube', status: 'active' })

    const { data: balance } = await member.rpc('get_credit_balance', { p_user_id: userId })
    expect(balance).toBe(4)

    // A second submission of the same URL is refused by the duplicate guard.
    const { error: dupe } = await member.rpc('create_content_entry', {
      p_platform: 'youtube',
      p_url: url,
      p_canonical_url: url,
      p_hashtags: tagIds,
    })
    expectSqlstate(dupe, '23505')

    await db.auth.admin.deleteUser(userId)
  })

  /* --- Concurrency ---------------------------------------------------------------
   *
   * The acceptance criterion: two concurrent submissions against a balance of exactly
   * one must succeed exactly once.
   *
   * `Promise.all` gives genuine overlap — both requests are in flight before either
   * response is awaited — which is exactly the race `pg_advisory_xact_lock` exists to
   * settle. pgTAP cannot express this: it runs a single session, and `dblink` would
   * require a superuser the stack does not grant.
   */
  it('lets exactly one of two concurrent submissions spend the last credit', async () => {
    const { id: userId, client: member } = await createMember(db)

    // Exactly one credit: the second submission must fail on the balance check.
    await db.from('credit_ledger').insert({
      user_id: userId,
      delta: 1,
      kind: 'admin_grant',
      status: 'available',
      note: 'concurrency fixture',
    })

    const stamp = Date.now()
    const submit = (slug: string) =>
      member.rpc('create_content_entry', {
        p_platform: 'youtube' as const,
        p_url: `https://integration.test/${slug}`,
        p_canonical_url: `https://integration.test/${slug}`,
        p_hashtags: tagIds,
      })

    const [first, second] = await Promise.all([
      submit(`race-a-${stamp}`),
      submit(`race-b-${stamp}`),
    ])

    const succeeded = [first, second].filter((r) => r.error === null)
    const failed = [first, second].filter((r) => r.error !== null)

    expect(succeeded, 'exactly one submission should have been funded').toHaveLength(1)
    expect(failed).toHaveLength(1)
    const [failedResult] = failed
    if (failedResult === undefined) throw new Error('expected one failed submission')
    expect(failedResult.error.message).toContain('Insufficient Credits')

    // And the ledger agrees: one entry, and a balance that never went negative.
    const { count: entryCount } = await db
      .from('content_entries')
      .select('*', { count: 'exact', head: true })
      .eq('author_id', userId)

    expect(entryCount).toBe(1)

    const { data: balance } = await member.rpc('get_credit_balance', { p_user_id: userId })
    expect(balance).toBe(0)

    await db.auth.admin.deleteUser(userId)
  })

  /* --- Reputation ----------------------------------------------------------------- */

  it('exposes reputation and balances to a signed-in member', async () => {
    // As a member, not as the service role: both RPCs read `auth.uid()` and answer
    // "Authentication required" without a session. The service role having EXECUTE
    // on them is necessary for jobs but is not a substitute for being a member.
    const member = await signIn('member_02@demo.test')
    const { data: session } = await member.auth.getUser()
    const userId = userIdOf(session.user)

    const { data: reputation, error: repError } = await member.rpc('get_reputation', {
      p_user_id: userId,
    })
    expect(repError).toBeNull()
    expect(typeof asRecord(reputation).total).toBe('number')
    expect(typeof asRecord(reputation).ratedCount).toBe('number')

    const { data: balance, error: balError } = await member.rpc('get_credit_balance', {
      p_user_id: userId,
    })
    expect(balError).toBeNull()
    expect(typeof balance).toBe('number')
  })

  it('reports that the service role is not a member', async () => {
    // The distinction is worth asserting rather than working around: these RPCs are
    // member-facing by design, and a job that needs one has to impersonate or use a
    // different path. Silently allowing it would remove that boundary.
    const { error } = await db.rpc('get_credit_balance', { p_user_id: adminId })
    expectSqlstate(error, '42501')
  })

  it('refuses a cross-member balance query', async () => {
    const member = await signIn('member_02@demo.test')
    const { data: hereSession } = await member.auth.getUser()
    const me = userIdOf(hereSession.user)

    const { data: others } = await db.from('profiles').select('id').neq('id', me).limit(1)

    const { error } = await member.rpc('get_credit_balance', {
      p_user_id: one(others, 'another profile').id,
    })
    expectSqlstate(error, '42501')
  })

  /* --- Job RPCs ------------------------------------------------------------------- */

  it('exposes release_held_credits to the service role only', async () => {
    const { error } = await db.rpc('release_held_credits')
    expect(error).toBeNull()

    const member = await signIn('member_03@demo.test')
    const { error: memberError } = await member.rpc('release_held_credits')
    expectSqlstate(memberError, '42501')
  })
})
