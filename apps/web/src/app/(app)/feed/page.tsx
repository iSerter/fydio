import type { Metadata } from 'next'
import { Suspense } from 'react'

import { PLATFORMS, type FeedReason, type Platform } from '@fydio/domain'
import { parseRankedRows, type RankedEntry } from '@fydio/supabase'

import { FeedClient } from '@/components/feed/FeedClient'
import { toCardEntry, type FeedCardEntry, type FeedCardCursor } from '@/components/feed/feed-entry'
import { FeedFilters } from '@/components/feed/FeedFilters'
import { avatarBucket, coversBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Feed | Fydio',
}

/**
 * Dynamic: per-member.
 *
 * The feed IS the member's five hashtags, their friendships and their muted
 * creators. There is no shared version of this page to cache, and the proxy has
 * already established a session by the time it renders.
 */
export const dynamic = 'force-dynamic'

/**
 * The curated home feed (T07).
 *
 * The whole page is a Server Component. The ranking happens in the database
 * (`rank_feed`), the first page is rendered here, and JavaScript is only needed for
 * "load more" and the impression observer — so a member sees content immediately
 * and the page works without it.
 *
 * WHY FILTERS ARE READ FROM THE URL HERE AND NOT IN `FeedClient`. A filter narrows
 * the ORDERING, and the ordering is what the cursor is a position in. If the client
 * filtered after fetching, "load more" would continue from a cursor computed against
 * a different total order and silently skip entries. Reading the filter server-side
 * and starting the cursor fresh is the only version that cannot skip.
 */
export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string | string[]; tag?: string | string[] }>
}) {
  const userId = await requireUserId()
  const supabase = await memberClient()
  const query = await searchParams

  // `getAll` rather than a bare read: two `?platform=` parameters is a legitimate
  // way to ask for two platforms, and taking only the last one would make the filter
  // behave differently depending on parameter order.
  const platforms = asList(query.platform).filter(isPlatform)
  const tagSlugs = asList(query.tag)

  // Slugs -> ids, in one query, before the ranking. Resolving tags first means the
  // ranker receives an id array and the filter is a single indexed predicate inside
  // it rather than a join layered over the results.
  const { data: tagRows } = tagSlugs.length
    ? await supabase
        .from('hashtags')
        .select('id, slug')
        .in('slug', tagSlugs)
    : { data: [] }

  const tagIds = (tagRows ?? []).map((row) => row.id)

  // Filter keys are omitted rather than set to null. An absent key reaches SQL as
  // NULL (what "no filter" means); an explicit JSON null bypasses the function's
  // defaults, and an empty array would match nothing.
  const { data: ranked, error } = await supabase.rpc('rank_feed', {
    p_limit: FEED_PAGE_SIZE + 1,
    ...(platforms.length > 0 ? { p_platforms: platforms } : {}),
    ...(tagIds.length > 0 ? { p_tags: tagIds } : {}),
  })

  if (error) {
    // A ranking failure is not an empty feed. Saying "nothing new yet" when the
    // database is unreachable is the single most misleading thing this page could
    // do, so it renders the reason instead.
    return <FeedError message={error.message} />
  }

  const rows: readonly RankedEntry[] = parseRankedRows(ranked)
  const hasMore = rows.length > FEED_PAGE_SIZE
  const page = hasMore ? rows.slice(0, FEED_PAGE_SIZE) : rows

  // Mapped here, on the server, because resolving Storage URLs needs `@/lib/env` —
  // which is `server-only` and cannot be imported by `FeedClient`. The first page goes
  // through the same shape as later ones so the client has one code path.
  const entries: FeedCardEntry[] = page.map((row) =>
    toCardEntry({
      payload: row.entry,
      score: row.score,
      // `reason_code` arrives as a plain string: PostgREST has no enum for a `text`
      // column, and the parser deliberately does not narrow it (see `feed-payload.ts`).
      // The cast is checked by the database's CHECK constraint and by the reason
      // assertions in `009_feed_ranking.sql`, so an unrecognised code fails a test
      // rather than reaching a member's screen.
      reason: row.reason_code as FeedReason,
      // Fydio's own copy first, then the remote URL the preview resolver captured.
      coverUrl:
        publicStorageUrl(coversBucket(), row.entry.thumbnailPath) ?? row.entry.thumbnailSource,
      avatarUrl: publicStorageUrl(avatarBucket(), row.entry.author.avatarPath),
    }),
  )

  const last = entries[entries.length - 1]

  const cursor: FeedCardCursor | null =
    hasMore && last !== undefined
      ? { score: last.score, publishedAt: last.publishedAt, id: last.id }
      : null

  const { data: vocabulary } = await supabase
    .from('hashtags')
    .select('id, slug, usage_count')
    .order('usage_count', { ascending: false })
    .limit(12)

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, handle')
    .eq('id', userId)
    .maybeSingle()

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {profile === null ? 'Your feed' : `Hi, ${profile.display_name}`}
        </h1>
        <p className="text-sm text-ink-muted">
          Ranked by your hashtags, the people you&rsquo;re connected to, and how recent each
          post is.
        </p>

        {/* The only route to the member's own profile that does not require guessing a
            URL. The nav cannot carry it because it never reads the handle, and without
            this link a new member has no way to reach their own page. */}
        {profile === null ? null : (
          <a
            href={`/u/${profile.handle}`}
            className="inline-flex w-fit items-center gap-1 text-sm text-brand hover:underline"
          >
            View your public profile (@{profile.handle})
          </a>
        )}
      </header>

      {/* `useSearchParams` in a Client Component opts the subtree into client-side
          rendering, so it is wrapped in Suspense with a static fallback rather than
          being allowed to deopt the whole feed. */}
      <Suspense fallback={<div className="h-20" aria-hidden="true" />}>
        <FeedFilters
          tags={tagSlugs}
          allTags={(vocabulary ?? []).map((row) => ({
            id: row.id,
            slug: row.slug,
            usage: row.usage_count,
          }))}
        />
      </Suspense>

      {entries.length === 0 ? (
        <EmptyState filtered={platforms.length > 0 || tagSlugs.length > 0} />
      ) : (
        <FeedClient
          initialEntries={entries}
          initialCursor={cursor}
          platforms={platforms.length > 0 ? platforms : undefined}
          tags={tagIds.length > 0 ? tagIds : undefined}
        />
      )}
    </main>
  )
}

/** Page size. Mirrors `app.feed_page_size`, the SQL default of 20. */
const FEED_PAGE_SIZE = 20

/** `?platform=a&platform=b` and `?platform=a` both mean a list. */
function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []

  return Array.isArray(value) ? value : [value]
}

/**
 * Narrow a query parameter to a real platform.
 *
 * A hand-typed `?platform=facebook` must not reach the RPC: the parameter is
 * user-controlled and the generated types say `platform_kind[]`, but a value the
 * enum has never heard of would fail the whole query and blank the feed rather than
 * being ignored.
 */
function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

/**
 * The empty feed.
 *
 * Distinguishes "no filters, genuinely nothing" from "the filter matched nothing",
 * because those need different words. "Nothing new yet — adjust your hashtags or
 * check back soon" is right for the first and actively misleading for the second:
 * the member's hashtags are fine, the filter is not.
 */
function EmptyState({ filtered }: { readonly filtered: boolean }) {
  if (filtered) {
    return (
      <div className="rounded-card border border-border bg-surface px-5 py-10 text-center">
        <h2 className="text-sm font-medium text-ink">Nothing matches these filters</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Try removing a platform or tag to widen the search.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface px-5 py-10 text-center">
      <h2 className="text-sm font-medium text-ink">Nothing new yet</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Adjust your hashtags on your profile, or check back soon.
      </p>
    </div>
  )
}

/**
 * A ranking failure, stated plainly.
 *
 * Deliberately does NOT render the reason text to the member — a PostgREST error can
 * name tables and functions. It is logged and replaced with something honest.
 */
function FeedError({ message }: { readonly message: string }) {
  console.error('rank_feed failed', message)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Your feed</h1>
      <p
        role="alert"
        className="rounded-control border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
      >
        The feed could not be loaded just now. Please try again in a moment.
      </p>
    </main>
  )
}