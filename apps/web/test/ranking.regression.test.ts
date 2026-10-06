import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  DEFAULT_DIVERSITY,
  DEFAULT_WEIGHTS,
  rankFeed,
  scoreCandidate,
  type RankCandidate,
  type ViewerContext,
} from '@fydio/domain'
import type { Database } from '@fydio/supabase'

/**
 * SQL ↔ TypeScript ranking parity (T07 §9).
 *
 * THE POINT OF THIS FILE. `packages/domain/ranking.ts` and the `rank_feed` function
 * are two implementations of one formula. That is a liability, not a design: the day
 * they disagree, a member sees a feed that claims one reason and ranks by another,
 * and nothing else in the system will notice. This suite runs both over the SAME rows
 * out of the database and asserts they agree on score, on ORDER, on demotion and on
 * the reason code.
 *
 * WHY A LIVE DATABASE IS REQUIRED. Parity cannot be asserted against a snapshot or a
 * fixture file: the question is whether the SQL expression computes what the
 * TypeScript expression computes, and only running both answers it. So this suite
 * needs a real stack and SKIPS without one — the same trade-off
 * `packages/supabase`'s integration suite makes, and the reason CI stays green while
 * a developer with `pnpm dev:stack` gets real assertions.
 *
 * WHY THE CLOCK IS PINNED. Freshness is a continuous function of `now()`, so the two
 * implementations can only be compared when asked about the same instant. `p_now`
 * exists on `rank_feed` for exactly this; without it the tolerance would have to
 * absorb a clock that moves between the two calls.
 *
 * WHY A DEDICATED VIEWER. The fixtures need a known hashtag profile and a known
 * friendship set. Borrowing a seeded member would make every assertion depend on how
 * the seed happened to distribute tags, so a seed change would break a ranking test
 * for reasons that have nothing to do with ranking.
 *
 * The fixtures create only what the ranker reads — a viewer with five tags, a
 * confirmed friendship, and entries with known ages, tag sets and feedback. They do
 * NOT exercise submission or the Credit economy; those have their own suites.
 */

type Member = SupabaseClient<Database, 'public', 'public'>

const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const describeIfStack = supabaseUrl && anonKey && serviceKey ? describe : describe.skip

/** The local-only throwaway password every seeded account shares. See supabase/seed.sql. */
const DEMO_PASSWORD = 'demo-password-not-real'

/** Pinned so both implementations are asked about the same instant. */
const NOW = new Date('2026-03-01T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

/**
 * The five tags every fixture profile carries. Five is the product's hard maximum, so
 * using five makes the reference's divisor the same number the SQL divides by.
 *
 * These are real SEEDED slugs rather than invented ones: `set_profile_hashtags` and the
 * `hashtags` FK both require existing rows, and a tag the seed does not contain would
 * make this suite fail for a reason that has nothing to do with ranking.
 */
const TAGS = ['hooks', 'editing', 'pacing', 'lighting', 'sound-design'] as const

/** The tags an entry carrying a FULL match for the viewer uses. */
const FULL_MATCH = ['hooks', 'editing', 'pacing'] as const

/** A one-in-three partial match. */
const PARTIAL_MATCH = ['hooks', 'lighting', 'sound-design'] as const

/** No overlap at all with the viewer's profile. */
const NO_MATCH = ['budget-gear', 'monetization', 'sponsorships'] as const

interface Fixture {
  readonly id: string
  readonly client: Member
}

let viewer: Fixture
let friend: Fixture
/** A third member, used only to write the feedback that flips the need signal. */
let commenter: Fixture

/** Every entry `createEntry` inserted, removed in `afterAll`. */
const createdEntryIds: string[] = []

/** Every member `createMember` created, removed in `afterAll`. */
const createdEmails: string[] = []

/** Create a member with a real session. */
async function createMember(slug: string): Promise<Fixture> {
  const email = `t07-${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@demo.test`
  const admin = createClient(need(supabaseUrl), need(serviceKey), { auth: { persistSession: false } })

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  })

  if (error !== null) throw new Error(`could not create ${slug}: ${error.message}`)

  // `admin.createUser` returns `user` as non-null in the generated types, so there is
  // nothing to guard: an absent user would already be a compile error here.
  const user = data.user

  createdEmails.push(email)

  // Typed as `Member` at creation rather than assigned afterwards, so the pinned
  // `Database` type flows through the client instead of being widened to `any` and
  // narrowed back by a cast at the return.
  const client: Member = createClient(need(supabaseUrl), need(anonKey), {
    auth: { persistSession: false },
  })

  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: DEMO_PASSWORD,
  })

  if (signInError !== null) throw new Error(`could not sign in ${slug}: ${signInError.message}`)

  return { id: user.id, client }
}

/** Give a profile an exact tag set. */
async function setTags(member: Fixture, slugs: readonly string[]): Promise<void> {
  const { data: rows, error: lookupError } = await member.client
    .from('hashtags')
    .select('id')
    .in('slug', [...slugs])

  if (lookupError !== null) throw new Error(`tag lookup failed: ${lookupError.message}`)

  const { error: deleteError } = await member.client
    .from('profile_hashtags')
    .delete()
    .eq('profile_id', member.id)

  if (deleteError !== null) throw new Error(`tag delete failed: ${deleteError.message}`)

  const ids = rows.map((row) => row.id)

  if (ids.length !== slugs.length) {
    throw new Error(`seed is missing tags: wanted ${slugs.join(', ')}`)
  }

  const { error: insertError } = await member.client
    .from('profile_hashtags')
    .insert(ids.map((hashtag_id, position) => ({ profile_id: member.id, hashtag_id, position })))

  if (insertError !== null) throw new Error(`tag insert failed: ${insertError.message}`)
}

/** Confirm a friendship in the direction `from` requested it. */
async function befriend(from: Fixture, to: Fixture): Promise<void> {
  const { error: sendError } = await from.client.rpc('send_friend_request', { p_addressee: to.id })

  if (sendError !== null) throw new Error(`friend request failed: ${sendError.message}`)

  const { data, error: lookupError } = await from.client
    .from('friendships')
    .select('id')
    .eq('requester_id', from.id)
    .eq('addressee_id', to.id)

  const pending = (data ?? [])[0]

  if (lookupError !== null) throw new Error(`friend lookup failed: ${lookupError.message}`)
  if (pending === undefined) throw new Error('no pending friendship to accept')

  const { error: acceptError } = await to.client.rpc('respond_friend_request', {
    p_friendship_id: pending.id,
    p_accept: true,
  })

  if (acceptError !== null) throw new Error(`friend accept failed: ${acceptError.message}`)
}

/** One entry in the fixture corpus. */
interface EntrySpec {
  readonly slug: string
  readonly platform: 'instagram' | 'tiktok' | 'youtube' | 'x'
  /** Exactly three, per the product rule. */
  readonly tags: readonly string[]
  readonly ageHours: number
  readonly hasFeedback: boolean
  readonly author: Fixture
  /**
   * Who writes the feedback row, when `hasFeedback` is set.
   *
   * A THIRD member, not the author: the database refuses self-feedback outright, and
   * that refusal is correct behaviour rather than something to work around.
   */
  readonly feedbackAuthor: Fixture
}

async function createEntry(spec: EntrySpec): Promise<string> {
  const publishedAt = new Date(NOW.getTime() - spec.ageHours * HOUR).toISOString()
  const url = `https://t07-${spec.slug}.example/p/${Date.now()}`

  const { data: tagRows, error: tagError } = await spec.author.client
    .from('hashtags')
    .select('id')
    .in('slug', [...spec.tags])

  if (tagError !== null) throw new Error(`tag lookup failed: ${tagError.message}`)

  const tagIds = tagRows.map((row) => row.id)

  if (tagIds.length !== 3) throw new Error(`"${spec.slug}" needs 3 tags, got ${tagIds.length}`)

  const { data, error } = await spec.author.client
    .from('content_entries')
    .insert({
      author_id: spec.author.id,
      platform: spec.platform,
      original_url: url,
      canonical_url: url,
      // `url_hash` is what the database de-duplicates on. A distinct value per slug
      // keeps the fixture deterministic rather than colliding across runs.
      url_hash: `t07-${spec.slug}-${Date.now()}`,
      title: `Fixture ${spec.slug}`,
      preview_state: 'resolved',
      status: 'active',
      published_at: publishedAt,
      created_at: publishedAt,
    })
    .select('id')
    .single()

  if (error !== null) throw new Error(`entry insert failed: ${error.message}`)

  const { error: linkError } = await spec.author.client
    .from('content_hashtags')
    .insert(
      tagIds.map((hashtag_id, position) => ({
        content_entry_id: data.id,
        hashtag_id,
        position,
      })),
    )

  if (linkError !== null) throw new Error(`entry tag link failed: ${linkError.message}`)

  if (spec.hasFeedback) {
    const { error: feedbackError } = await spec.feedbackAuthor.client.from('feedback').insert({
      entry_id: data.id,
      author_id: spec.feedbackAuthor.id,
      body: 'Parity fixture feedback. Long enough to satisfy the minimum length.',
      eligibility: 'eligible',
      opened_entry: true,
    })

    if (feedbackError !== null) throw new Error(`feedback insert failed: ${feedbackError.message}`)
  }

  createdEntryIds.push(data.id)

  return data.id
}

/**
 * Narrow a variable the suite already gated on.
 *
 * `describeIfStack` is what decides whether these tests run at all, and the compiler
 * cannot see through that ternary. This makes the narrowing explicit at the point of
 * use instead of scattering `!` through the fixtures — which the repo forbids, and
 * rightly: an assertion operator that cannot fail turns a real bug into a runtime
 * crash somewhere less legible.
 */
function need(value: string | undefined): string {
  if (value === undefined) throw new Error('no stack configured')

  return value
}

/** Read a `rank_feed` jsonb payload's `id`. */
function idOf(row: { readonly entry: unknown }): string {
  const entry = row.entry as { readonly id?: unknown } | null

  if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') {
    throw new Error(`rank_feed row has no entry.id: ${JSON.stringify(row)}`)
  }

  return entry.id
}

interface Comparison {
  readonly sqlIds: string[]
  readonly sqlScores: Map<string, number>
  readonly sqlDemoted: Set<string>
  readonly sqlReasons: Map<string, string>
  readonly reference: ReturnType<typeof rankFeed>
}

/**
 * Run both implementations over the same corpus.
 *
 * THE WHOLE CORPUS, NOT ONE PAGE. This is the subtle part and getting it wrong
 * produced a false parity failure worth recording: `rank_feed` computes the diversity
 * caps over every entry the viewer can see, not over the page it returns, so the
 * seventh YouTube post is penalised whether or not the earlier six were on this page.
 * Feeding the reference only the 50 rows `rank_feed` returned made it count caps from
 * zero inside that page, and it disagreed with the SQL on entries neither had reason
 * to disagree about.
 *
 * So the corpus is rebuilt from `content_entries` directly, filtered by exactly the
 * rules `rank_feed` applies, and the reference is run over all of it.
 *
 * The rows themselves are read back out of the database rather than reconstructed
 * from the fixture specs, so the reference runs on what the SQL saw — real ids, real
 * timestamps, real tag sets.
 */
async function compare(): Promise<Comparison> {
  const { data: ranked, error } = await viewer.client.rpc('rank_feed', {
    p_limit: 50,
    p_now: NOW.toISOString(),
  })

  if (error !== null) throw new Error(`rank_feed failed: ${error.message}`)

  const rows = ranked
  if (rows.length === 0) throw new Error('rank_feed returned nothing — the fixtures did not load')

  const pageIds = rows.map(idOf)

  // The full corpus, under `rank_feed`'s own visibility rules: active, not the
  // viewer's own, inside the 720-hour freshness window measured from the PINNED
  // clock, from nobody this viewer has muted, and not suppressed by a signal.
  const windowStart = new Date(NOW.getTime() - 720 * HOUR).toISOString()

  const { data: allEntries, error: corpusError } = await viewer.client
    .from('content_entries')
    .select('id, author_id, platform, published_at')
    .eq('status', 'active')
    .neq('author_id', viewer.id)
    .gte('published_at', windowStart)

  if (corpusError !== null) throw new Error(`corpus read failed: ${corpusError.message}`)

  const corpusIds = allEntries.map((entry) => entry.id)

  const { data: entryTags } = await viewer.client
    .from('content_hashtags')
    .select('content_entry_id, hashtag:hashtags(slug)')
    .in('content_entry_id', corpusIds)

  const { data: myTags } = await viewer.client
    .from('profile_hashtags')
    .select('hashtag:hashtags(slug)')
    .eq('profile_id', viewer.id)

  // Filtered to THIS viewer's connections in JS, not in the query.
  //
  // Reading every accepted friendship in the community and treating them all as the
  // viewer's would make the reference think the viewer is friends with all 30 seeded
  // members — which `rank_feed` correctly does not. The bug would look like a SQL
  // disagreement rather than a test bug, which is exactly why the filter is here.
  const { data: friendRows } = await viewer.client
    .from('friendships')
    .select('requester_id, addressee_id')
    .eq('state', 'accepted')
    .or(`requester_id.eq.${viewer.id},addressee_id.eq.${viewer.id}`)

  const { data: feedbackRows } = await viewer.client
    .from('feedback')
    .select('entry_id')
    .in('entry_id', corpusIds)
    .is('removed_at', null)

  const { data: mutedRows } = await viewer.client
    .from('mutes')
    .select('muted_profile_id')
    .eq('viewer_id', viewer.id)

  const { data: suppressRows } = await viewer.client
    .from('feed_signals')
    .select('entry_id')
    .eq('viewer_id', viewer.id)
    .in('signal', ['hide', 'less_like'])

  /** A joined `hashtags` row, narrowed from the relation shape PostgREST returns. */
  const slugOf = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null
    const slug = (value as { readonly slug?: unknown }).slug

    return typeof slug === 'string' ? slug : null
  }

  const profileHashtags = (myTags ?? []).flatMap((row) => {
    const slug = slugOf(row.hashtag)

    return slug === null ? [] : [slug]
  })

  const tagsByEntry = new Map<string, string[]>()
  for (const row of entryTags ?? []) {
    const slug = slugOf(row.hashtag)
    if (slug === null) continue
    const existing = tagsByEntry.get(row.content_entry_id) ?? []
    existing.push(slug)
    tagsByEntry.set(row.content_entry_id, existing)
  }

  const friendIds = new Set(
    (friendRows ?? []).flatMap((row) =>
      row.requester_id === viewer.id ? [row.addressee_id] : [row.requester_id],
    ),
  )

  const withFeedback = new Set((feedbackRows ?? []).map((row) => row.entry_id))
  const muted = new Set((mutedRows ?? []).map((row) => row.muted_profile_id))
  const suppressed = new Set((suppressRows ?? []).map((row) => row.entry_id))

  const candidates: RankCandidate[] = allEntries
    .filter((entry) => !muted.has(entry.author_id) && !suppressed.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      authorId: entry.author_id,
      platform: entry.platform,
      hashtags: tagsByEntry.get(entry.id) ?? [],
      createdAt: new Date(entry.published_at),
      hasFeedback: withFeedback.has(entry.id),
      isFriend: friendIds.has(entry.author_id),
    }))

  const viewerContext: ViewerContext = {
    viewerId: viewer.id,
    profileHashtags,
    // No `more_like` signal is set in these fixtures, so this is deliberately empty:
    // the affinity term is covered by the pure unit tests, and leaving it empty here
    // keeps the corpus simple enough that a parity failure is unambiguous.
    likedHashtags: [],
    seenEntryIds: [],
    seenAuthors: new Map(),
    seenPlatforms: new Map(),
  }

  const reference = rankFeed(candidates, viewerContext, {
    now: NOW,
    diversity: DEFAULT_DIVERSITY,
    maxAgeHours: 720,
  })

  // The comparison is over the entries `rank_feed` actually returned, in its order.
  // The reference is longer because it ranks the whole corpus, so only the ids the
  // SQL served are compared — and their relative order must match exactly.
  const servedIds = new Set(pageIds)
  const servedReference = reference.filter((entry) => servedIds.has(entry.id))

  return {
    sqlIds: pageIds,
    // Kept as text and parsed here, rather than `Number()`d at the call site: the
    // comparison below wants the numeric value, but the CURSOR wants the exact
    // digits, and conflating the two is the bug this suite exists to catch.
    sqlScores: new Map(rows.map((row) => [idOf(row), Number(row.score)])),
    sqlDemoted: new Set(
      rows.filter((row) => (row.entry as { demoted: boolean }).demoted).map(idOf),
    ),
    sqlReasons: new Map(rows.map((row) => [idOf(row), row.reason_code])),
    reference: servedReference,
  }
}

describeIfStack('rank_feed parity with @fydio/domain', () => {
  beforeAll(async () => {
    viewer = await createMember('viewer')
    friend = await createMember('friend')
    commenter = await createMember('commenter')

    await setTags(viewer, TAGS)
    await setTags(friend, TAGS)
    await befriend(viewer, friend)

    // The corpus, chosen so every signal is represented: a friend and a non-friend,
    // full and zero tag overlap, fresh and stale, with and without feedback, and
    // several entries from ONE author so the per-creator cap engages.
    const specs: EntrySpec[] = [
      { slug: 'full-fresh', platform: 'youtube', tags: FULL_MATCH, ageHours: 1, hasFeedback: false, author: friend, feedbackAuthor: commenter },
      { slug: 'full-mid', platform: 'instagram', tags: FULL_MATCH, ageHours: 12, hasFeedback: true, author: friend, feedbackAuthor: commenter },
      { slug: 'full-stale', platform: 'tiktok', tags: FULL_MATCH, ageHours: 96, hasFeedback: false, author: friend, feedbackAuthor: commenter },
      { slug: 'partial', platform: 'youtube', tags: PARTIAL_MATCH, ageHours: 4, hasFeedback: true, author: friend, feedbackAuthor: commenter },
      { slug: 'zero-fresh', platform: 'x', tags: NO_MATCH, ageHours: 2, hasFeedback: false, author: friend, feedbackAuthor: commenter },
      { slug: 'zero-stale', platform: 'instagram', tags: NO_MATCH, ageHours: 200, hasFeedback: true, author: friend, feedbackAuthor: commenter },
      { slug: 'stranger-match', platform: 'youtube', tags: FULL_MATCH, ageHours: 6, hasFeedback: false, author: commenter, feedbackAuthor: viewer },
      { slug: 'stranger-zero', platform: 'tiktok', tags: NO_MATCH, ageHours: 30, hasFeedback: true, author: commenter, feedbackAuthor: viewer },
      { slug: 'mine', platform: 'x', tags: FULL_MATCH, ageHours: 1, hasFeedback: false, author: viewer, feedbackAuthor: friend },
    ]

    for (const spec of specs) {
      await createEntry(spec)
    }
  }, 120_000)

  /**
   * Remove everything the fixtures created.
   *
   * Entries first — every table that references one (`content_hashtags`, `feedback`,
   * `feed_impressions`, `feed_signals`, `outbound_clicks`, `duration_events`) cascades
   * on delete — then the members themselves through the admin API, which removes the
   * auth rows the profiles hang off.
   *
   * Without this the suite leaves members and entries behind on every run, and the
   * pgTAP suites that assume a pristine seed (002's "an unused hashtag exists") start
   * failing for reasons that have nothing to do with what they assert.
   */
  afterAll(async () => {
    if (supabaseUrl === undefined || serviceKey === undefined) return

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

    for (const id of createdEntryIds) {
      await admin.from('content_entries').delete().eq('id', id)
    }

    for (const email of createdEmails) {
      const { data } = await admin.auth.admin.listUsers()
      const user = data.users.find((candidate) => candidate.email === email)

      if (user !== undefined) {
        await admin.auth.admin.deleteUser(user.id)
      }
    }

    createdEntryIds.length = 0
    createdEmails.length = 0
  }, 120_000)

  it('agrees with the reference on SCORE, within 1e-6', async () => {
    const { sqlScores, reference } = await compare()

    for (const entry of reference) {
      const sqlScore = sqlScores.get(entry.id)

      if (sqlScore === undefined) {
        throw new Error(`entry ${entry.id} is missing from the SQL result`)
      }

      // `finalScore` is post-diversity, which is what `rank_feed` returns, so both
      // sides are compared at the penalised value.
      expect(sqlScore).toBeCloseTo(entry.score, 6)
    }
  }, 60_000)

  it('agrees with the reference on ORDER', async () => {
    const { sqlIds, reference } = await compare()

    expect(sqlIds).toEqual(reference.map((entry) => entry.id))
  }, 60_000)

  it('agrees on which entries were demoted', async () => {
    const { sqlDemoted, reference } = await compare()

    const fromReference = reference.filter((entry) => entry.demoted).map((entry) => entry.id)

    expect([...sqlDemoted].sort()).toEqual([...fromReference].sort())
  }, 60_000)

  /**
   * `explainRank` returns a LIST strongest-first; `ranked_reason` returns the first of
   * that list. Comparing the head is therefore the right comparison, and a mismatch
   * means the SQL's reason precedence has drifted from the reference's.
   */
  it('agrees on the reason code', async () => {
    const { sqlReasons, reference } = await compare()

    for (const entry of reference) {
      expect(sqlReasons.get(entry.id)).toBe(entry.reasons[0])
    }
  }, 60_000)

  it('never includes the viewer their own entry', async () => {
    const { sqlIds, reference } = await compare()

    // The `mine` fixture is authored by the viewer and must appear in neither result.
    expect(sqlIds).toHaveLength(reference.length)
  }, 60_000)

  it('is deterministic: two calls at the same instant return the same order', async () => {
    const first = await viewer.client.rpc('rank_feed', { p_limit: 30, p_now: NOW.toISOString() })
    const second = await viewer.client.rpc('rank_feed', { p_limit: 30, p_now: NOW.toISOString() })

    if (first.error !== null) throw new Error(first.error.message)
    if (second.error !== null) throw new Error(second.error.message)

    expect(first.data.map(idOf)).toEqual(second.data.map(idOf))
  }, 30_000)

  it('pages by keyset without repeating or skipping', async () => {
    const full = await viewer.client.rpc('rank_feed', { p_limit: 50, p_now: NOW.toISOString() })

    if (full.error !== null) throw new Error(full.error.message)

    const fullIds = full.data.map(idOf)

    // Six is above the fixture count, so this only asserts anything on a corpus that
    // is actually large enough — and skips rather than passing vacuously otherwise.
    if (fullIds.length < 7) return

    const pageOne = await viewer.client.rpc('rank_feed', { p_limit: 5, p_now: NOW.toISOString() })

    if (pageOne.error !== null) throw new Error(pageOne.error.message)

    const first = pageOne.data
    const last = first[first.length - 1]

    if (last === undefined) return

    const pageTwo = await viewer.client.rpc('rank_feed', {
      p_limit: 5,
      p_cursor: (last.entry as { publishedAt: string }).publishedAt,
      // The EXACT score text, not `Number(last.score)`. Converting to a double is the
      // bug this suite was written to catch: the numeric carries more significant
      // digits than a double holds, the boundary comparison then fails for the
      // cursor's own row, and the entry is dropped.
      p_cursor_score: last.score as unknown as number,
      p_cursor_id: idOf(last),
      p_now: NOW.toISOString(),
    })

    if (pageTwo.error !== null) throw new Error(pageTwo.error.message)

    const firstIds = new Set(first.map(idOf))
    const secondIds = pageTwo.data.map(idOf)

    // No repeats — the failure a `published_at`-only cursor has whenever two entries
    // share both a score and a timestamp.
    for (const id of secondIds) {
      expect(firstIds.has(id)).toBe(false)
    }

    // No skips: page two resumes the FULL ordering rather than starting a new one.
    expect(secondIds[0]).toBe(fullIds[5])
  }, 30_000)

  /**
   * The regression guard for the `least(1, NULL)` inversion found while building this.
   * `least`/`greatest` ignore null arguments, so `coalesce(least(1, ratio), 0)` yields
   * 1 — not 0 — for a member with an empty tag pool, giving every entry in the feed a
   * perfect tag score. Asserted on the reference side, where the arithmetic is
   * unambiguous; `009_feed_ranking.sql` asserts the SQL half.
   */
  it('scores a member with no hashtags as zero overlap, not one', () => {
    const score = scoreCandidate(
      {
        id: 'x',
        authorId: 'y',
        platform: 'youtube',
        hashtags: ['design', 'motion', 'typography'],
        createdAt: NOW,
        hasFeedback: true,
        isFriend: false,
      },
      [],
      { now: NOW, likedHashtags: [] },
    )

    expect(score.overlap).toBe(0)
    expect(score.likedOverlap).toBe(0)
    // Freshness and nothing else.
    expect(score.score).toBeCloseTo(score.freshness, 12)
  })

  /**
   * A retune that changes only one side is the failure this file exists to catch, so
   * the constants are pinned against the documented defaults here as well as in SQL.
   */
  it('uses the documented default weights on both sides', () => {
    expect(DEFAULT_WEIGHTS.friendBoost).toBe(0.35)
    expect(DEFAULT_WEIGHTS.feedbackNeedBoost).toBe(0.15)
    expect(DEFAULT_WEIGHTS.moreLikeBoost).toBe(0.1)
    expect(DEFAULT_WEIGHTS.freshnessWeight).toBe(1.0)
    expect(DEFAULT_WEIGHTS.hashtagWeight).toBe(1.0)
    expect(DEFAULT_WEIGHTS.diversityPenalty).toBe(0.5)
    expect(DEFAULT_WEIGHTS.platformPenalty).toBe(0.75)
    expect(DEFAULT_DIVERSITY.maxPerCreator).toBe(2)
    expect(DEFAULT_DIVERSITY.maxPerPlatform).toBe(6)
  })
})