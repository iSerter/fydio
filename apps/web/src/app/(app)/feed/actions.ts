'use server'

/**
 * Server Actions for the curated feed (T07).
 *
 * Server Actions rather than API routes: these are called from components inside
 * the app, not by third parties. Next wraps them so the endpoint cannot be invoked
 * from another origin, which is one less thing to get right than a `POST /feed/...`
 * route handler would be.
 *
 * EVERY WRITE GOES THROUGH AN RPC. `submit_feed_signal`, `mute_creator` and
 * `log_feed_impressions` are all `security definer` functions in the database, and
 * that is not an implementation detail — the ranking reads those rows directly, so
 * a write that bypassed the RPC would be a write the ranker could not see. It also
 * means the RLS policies on `feed_signals` and `mutes` stay simple: read your own,
 * write your own, and the one rule that needs care (per-signal uniqueness) lives in
 * SQL where a constraint can enforce it.
 */

import { revalidatePath } from 'next/cache'

import type { FeedReason } from '@fydio/domain'
import { parseRankedRows, type PlatformKind, type RankedEntry } from '@fydio/supabase'

import { toCardEntry, type FeedCardEntry } from '@/components/feed/feed-entry'
import { avatarBucket, coversBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

/** Re-exported from `domain` so client components have one import for feed types. */
export type { FeedReason }

export interface ActionResult {
  readonly ok: boolean
  readonly message?: string
}

/**
 * The filters a feed can be read under.
 *
 * A field left out (or empty) means "no filter". Empty arrays are treated the same
 * as absent rather than passed through, because an empty `p_platforms` array would
 * reach SQL as `'{}'` and match nothing — turning "no filter" into "show me an empty
 * feed" is a failure mode a UI bug could cause silently.
 */
export interface FeedFilters {
  readonly platforms?: readonly PlatformKind[] | undefined
  /** Hashtag ids forming the tag pool. */
  readonly tags?: readonly string[] | undefined
}

/**
 * The position of the last row on a page, which is what the next page starts after.
 *
 * All THREE components of the sort key, not just the timestamp. The feed is ordered
 * by `(score desc, published_at desc, id asc)`, so a cursor carrying only the
 * timestamp is stable only until two entries share a score AND a timestamp — at
 * which point one is silently repeated or skipped on every subsequent page.
 */
export interface FeedCursor {
  /**
   * The last seen entry's score, as the EXACT string `rank_feed` produced.
   *
   * Not a `number`. The score is exact decimal arithmetic with more significant digits
   * than an IEEE double can represent; parsing it into one and sending it back makes
   * the next page's `score = cursor_score` comparison fail for the cursor's own row,
   * dropping an entry at every page boundary. The string is the fix, and it costs
   * nothing because the client never does arithmetic on it.
   */
  readonly score: string
  readonly publishedAt: string
  readonly id: string
}

export interface FeedPage {
  /**
   * Card-shaped entries, with Storage URLs already resolved.
   *
   * Resolved HERE rather than in `FeedClient`, because `@/lib/env` is `server-only`:
   * this is a Server Action, so it can read `STORAGE_BUCKET_*`, and the client cannot.
   * The alternative — shipping bucket names to the browser — would leak server
   * configuration into the bundle for no benefit.
   */
  readonly entries: readonly FeedCardEntry[]
  /**
   * The cursor for the next page, or `null` when the feed is exhausted.
   *
   * `null` is a real answer, not an error: a member who has read everything recent
   * should see "you're all caught up", and inferring that from a short page would
   * be wrong the moment a filter happens to exclude most of the corpus.
   */
  readonly nextCursor: FeedCursor | null
}

/**
 * Read one page of the ranked feed.
 *
 * `limit + 1` is requested and the extra row discarded, because "is there another
 * page?" cannot be answered from the length of the page you asked for: the database
 * will happily return exactly `limit` rows and there may still be a twenty-first.
 */
export async function loadFeedPage(options: {
  readonly limit?: number
  readonly cursor?: FeedCursor | null
  readonly filters?: FeedFilters
}): Promise<FeedPage> {
  await requireUserId()
  const supabase = await memberClient()

  const limit = options.limit ?? 20
  const filters = options.filters ?? {}

  // Keys are OMITTED rather than set to `null`/`undefined`, and that is not a style
  // choice. PostgREST sends an absent key as SQL NULL (which the function's defaults
  // expect) and an explicit JSON `null` as a value that bypasses them; the generated
  // arg types are optional-but-not-undefined, so under `exactOptionalPropertyTypes`
  // passing `null` is also a compile error. The conditional spread is what satisfies
  // all three constraints at once.
  const rpcArgs = {
    p_limit: limit + 1,
    ...(options.cursor === undefined || options.cursor === null
      ? {}
      : {
          // The cursor travels as three separate arguments because `rank_feed` takes
          // three: a partial cursor is rejected there rather than silently returning
          // an empty feed, and this is the only caller that has to get it right.
          p_cursor: options.cursor.publishedAt,
          // The exact score TEXT, deliberately not `Number(score)`. The generated arg
          // type says `number` because PostgREST infers numeric arguments from the SQL
          // declaration, but a `numeric` with ~20 significant digits cannot survive the
          // trip through a JSON number and back — and the cursor is exactly the value
          // that has to survive it. Postgres casts the text to numeric itself, with
          // every digit intact.
          //
          // The cast is at this boundary and nowhere else: `FeedCursor.score` is a
          // string for its whole life, so no other code can accidentally round it.
          p_cursor_score: options.cursor.score as unknown as number,
          p_cursor_id: options.cursor.id,
        }),
    ...(filters.platforms === undefined || filters.platforms.length === 0
      ? {}
      : // `[...filters.platforms]`: the generated arg type is a mutable array while
        // `FeedFilters` is `readonly` (these come from query params and should not be
        // mutable through this interface). The spread is that conversion, and it is a
        // copy — which is what lets the caller keep its array immutable.
        { p_platforms: [...filters.platforms] }),
    ...(filters.tags === undefined || filters.tags.length === 0
      ? {}
      : { p_tags: [...filters.tags] }),
  }

  const { data, error } = await supabase.rpc('rank_feed', rpcArgs)

  if (error) {
    throw new Error(`Could not load the feed: ${error.message}`)
  }

  // Parsed, not cast: PostgREST types this as `Json`, and a projection change in the
  // SQL would otherwise reach the card as `undefined` for every field.
  const rows: readonly RankedEntry[] = parseRankedRows(data)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  const last = page[page.length - 1]

  const entries: FeedCardEntry[] = page.map((row) =>
    toCardEntry({
      payload: row.entry,
      score: row.score,
      reason: row.reason_code as FeedReason,
      // Storage key first, then the remote URL the preview resolver captured. Fydio's
      // own copy is preferred because its lifetime is one we control.
      coverUrl:
        publicStorageUrl(coversBucket(), row.entry.thumbnailPath) ?? row.entry.thumbnailSource,
      avatarUrl: publicStorageUrl(avatarBucket(), row.entry.author.avatarPath),
    }),
  )

  return {
    entries,
    nextCursor:
      hasMore && last !== undefined
        ? {
            // Carried as the EXACT string the database produced, not as a number.
            // `rank_feed` returns text for precisely this reason: the score has more
            // significant digits than a double holds, and rounding it on the way out
            // makes the next page's `score = cursor_score` comparison fail for the
            // cursor's own row — silently dropping an entry at every page boundary.
            score: last.score,
            publishedAt: last.entry.publishedAt,
            id: last.entry.id,
          }
        : null,
  }
}

/**
 * WHY THERE IS NO `reasonLabel` HELPER HERE.
 *
 * A `'use server'` module may only export async functions, so the obvious place for a
 * synchronous `reasonLabel(reason) => FEED_REASON_LABELS[reason]` is a build error, and
 * wrapping it in a pointless `async` is worse than not having it: it would put a
 * promise in the render path for a pure lookup.
 *
 * The labels are read directly from `FEED_REASON_LABELS` by `RankingReasonChip`, which
 * is a Server Component. The SQL copy in `feed_reason_label` exists so pgTAP can prove
 * every code the ranker can emit resolves to a real sentence — a label that only exists
 * in the client bundle is invisible until a member sees it on screen.
 */

/**
 * Record that the viewer actually SAW these entries.
 *
 * Called from a viewport observer, never on render. A card scrolled straight past
 * is not a view of anything, and counting it would inflate every open-rate number
 * T09 reports.
 *
 * `score` and `reason` are RELAYED from the `rank_feed` response the same page is
 * rendering, not recomputed — the ranker already did the work. They cross a client
 * boundary, so `log_feed_impressions` validates the reason against the vocabulary
 * and clamps the score into `numeric(8,4)`. An impression table fed unvalidated
 * client numbers is not a metric table.
 */
export async function logImpressions(
  entries: readonly {
    readonly entryId: string
    readonly position: number
    /** The ranker's exact score text. `undefined` when unknown; the RPC stores null. */
    readonly score: string | undefined
    readonly reason: string | undefined
  }[],
): Promise<void> {
  if (entries.length === 0) return

  await requireUserId()
  const supabase = await memberClient()

  const { error } = await supabase.rpc('log_feed_impressions', {
    p_entries: entries.map((entry) => ({
      entryId: entry.entryId,
      position: entry.position,
      score: entry.score,
      reason: entry.reason,
    })),
  })

  // Swallowed deliberately. A failed impression must never surface as an error in a
  // feed that rendered perfectly well — the member's experience of the feed does not
  // depend on our analytics succeeding.
  if (error) {
    console.error('logImpressions failed', error.message)
  }
}

/**
 * Apply a feed tuning signal.
 *
 * These affect ONLY Fydio's recommendations. Nothing here touches the creator, the
 * platform, or any external system — the product brief is explicit about that, and
 * it is why `hide` is recorded here rather than anywhere near the entry.
 */
export async function submitFeedSignal(
  entryId: string,
  signal: 'more_like' | 'less_like' | 'hide' | 'unhide',
): Promise<ActionResult> {
  await requireUserId()
  const supabase = await memberClient()

  const { error } = await supabase.rpc('submit_feed_signal', {
    p_entry_id: entryId,
    p_signal: signal,
  })

  if (error) {
    // Passed through rather than replaced: the RPC raises with a message about a
    // signal it does not recognise or an entry that is not there, and that is
    // exactly what the member needs to read.
    return { ok: false, message: error.message }
  }

  // The feed is per-member and its contents just changed, so the cached RSC for
  // `/feed` is stale. Revalidated rather than mutated: there is no optimistic list
  // to patch, and the next render is the honest one.
  revalidatePath('/feed')

  return { ok: true }
}

/**
 * Mute a creator, or unmute them.
 *
 * A mute is a preference, not a block. Nothing about the relationship changes and
 * the creator is not notified — which is why this lives in its own table rather
 * than reusing `friendships`' `blocked` state, where the two would be
 * indistinguishable once written.
 */
export async function setCreatorMuted(profileId: string, muted: boolean): Promise<ActionResult> {
  await requireUserId()
  const supabase = await memberClient()

  const { error } = await supabase.rpc(muted ? 'mute_creator' : 'unmute_creator', {
    p_profile_id: profileId,
  })

  if (error) {
    return { ok: false, message: error.message }
  }

  revalidatePath('/feed')

  return { ok: true }
}