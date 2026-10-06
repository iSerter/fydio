'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { FeedReason, Platform } from '@fydio/domain'

import { FeedEntryCard } from '@/components/feed/FeedEntryCard'
import type { FeedCardCursor, FeedCardEntry } from '@/components/feed/feed-entry'

/**
 * The scrollable feed with keyset pagination and impression logging (T07 §5.3-5.4).
 *
 * WHY THIS IS A CLIENT COMPONENT. The first page is rendered on the server and
 * arrives as HTML — the feed is the app's landing page and it must be readable
 * without JavaScript. This component takes over only to add "load more" and the
 * viewport observer, neither of which can exist on a server.
 *
 * IMPRESSIONS FIRE ON VIEWPORT ENTRY, NEVER ON RENDER. A card scrolled straight
 * past is not a view of anything; counting it would inflate every open-rate number
 * T09 reports. The observer is created once against the container and entries are
 * reported as they intersect, which also means "load more" is covered for free —
 * a newly appended card intersects too, without any per-card effect.
 *
 * NO INFINITE SCROLL. An explicit button, per the task's scope: a member reading a
 * feed should be able to stop, and an auto-loading feed gives them no way to
 * indicate they are done.
 */

export interface FeedClientProps {
  readonly initialEntries: readonly FeedCardEntry[]
  readonly initialCursor: FeedCardCursor | null
  /** Omitted means "no filter". `FeedFilters` treats an empty array the same way. */
  readonly platforms: readonly Platform[] | undefined
  readonly tags: readonly string[] | undefined
}

export function FeedClient({
  initialEntries,
  initialCursor,
  platforms,
  tags,
}: FeedClientProps) {
  const [entries, setEntries] = useState<readonly FeedCardEntry[]>(initialEntries)
  const [cursor, setCursor] = useState<FeedCardCursor | null>(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Kept in a ref rather than derived per render: the observer's callbacks are
  // registered once per `entries` change and would otherwise close over the first
  // render's map, logging stale scores for every card after the first page.
  useEffect(() => {
    const map = metaRef.current

    for (const entry of entries) {
      map.set(entry.id, { score: entry.score, reason: entry.reason })
    }
  }, [entries])

  /**
   * Optimistic removal when a tuning control fires.
   *
   * `revalidatePath('/feed')` only affects the next SERVER render, and this list is
   * client state — without this listener a pressed Hide would do nothing visible
   * until the member reloaded. The server remains the authority; this is immediacy,
   * and the next navigation renders the true state.
   */
  useEffect(() => {
    function removeEntry(event: Event) {
      const id = (event as CustomEvent<string>).detail

      setEntries((current) => current.filter((entry) => entry.id !== id))
    }

    function removeAuthor(event: Event) {
      const authorId = (event as CustomEvent<string>).detail

      setEntries((current) => current.filter((entry) => entry.author.id !== authorId))
    }

    document.addEventListener('fydio:feed-remove', removeEntry)
    document.addEventListener('fydio:feed-remove-author', removeAuthor)

    return () => {
      document.removeEventListener('fydio:feed-remove', removeEntry)
      document.removeEventListener('fydio:feed-remove-author', removeAuthor)
    }
  }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  /** Entries already reported, so scrolling back up does not re-log them. */
  const loggedRef = useRef<Set<string>>(new Set())
  /** Batched so a fast scroll produces one request, not one per card. */
  const pendingRef = useRef<
    {
      entryId: string
      position: number
      score: string | undefined
      reason: string | undefined
    }[]
  >([])
  /** Score and reason by entry, for the impression batch. From the ranker, not recomputed. */
  const metaRef = useRef<Map<string, { score: string; reason: FeedReason }>>(new Map())

  const reportImpressions = useCallback(async () => {
    const batch = pendingRef.current

    if (batch.length === 0) return

    pendingRef.current = []

    const { logImpressions } = await import('@/app/(app)/feed/actions')

    await logImpressions(batch)
  }, [])

  /**
   * Positions are read from the DOM at report time rather than baked in at render.
   *
   * A card's slot in the feed changes when one above it is hidden, so an index
   * captured when the card was created goes stale the moment a tuning control is
   * used — and `position` is what the open-rate metric is bucketed by. Reading it
   * when the card actually comes into view is the only version that is true.
   */
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue

          const element = record.target as HTMLElement
          const entryId = element.dataset.entryId

          if (entryId === undefined || loggedRef.current.has(entryId)) continue

          loggedRef.current.add(entryId)

          const position = Number(element.dataset.position ?? '0')

          if (Number.isFinite(position) && position > 0) {
            const meta = metaRef.current.get(entryId)

            pendingRef.current.push({
              entryId,
              position,
              score: meta?.score,
              reason: meta?.reason,
            })
          }
        }

        if (pendingRef.current.length > 0) void reportImpressions()
      },
      // `rootMargin` buys a little lead time: a card is logged once it is MOSTLY
      // visible rather than the instant one pixel clears the fold, which is closer
      // to what "the member saw this" means.
      { rootMargin: '0px 0px -10% 0px' },
    )

    for (const element of container.querySelectorAll('[data-entry-id]')) {
      observer.observe(element)
    }

    return () => { observer.disconnect(); }
  }, [entries, reportImpressions])

  /**
   * Flush on unmount.
   *
   * A member who reads three cards and navigates away has still seen three cards,
   * and an observer torn down without a final flush loses the batch that had not yet
   * been scheduled. `visibilitychange` covers the tab-closed case, which React's
   * unmount does not.
   */
  useEffect(() => {
    function flush() {
      if (pendingRef.current.length > 0) void reportImpressions()
    }

    document.addEventListener('visibilitychange', flush)

    return () => {
      document.removeEventListener('visibilitychange', flush)
      flush()
    }
  }, [reportImpressions])

  async function loadMore() {
    if (cursor === null || loading) return

    setLoading(true)
    setError(null)

    try {
      const { loadFeedPage } = await import('@/app/(app)/feed/actions')

      const page = await loadFeedPage({
        cursor,
        filters: { platforms, tags },
      })

      // `loadFeedPage` returns ranked rows already mapped to card props, Storage URLs
      // resolved. Mapping them here is not an option: resolving needs `server-only`.
      const incoming: readonly FeedCardEntry[] = page.entries

      setEntries((current) => {
        // Deduplicated defensively. The keyset is meant to make overlap impossible,
        // and an entry published between two pages still cannot appear twice in one
        // member's feed — a duplicate card reads as a bug in a way a missing one does
        // not.
        const seen = new Set(current.map((entry) => entry.id))
        return [...current, ...incoming.filter((entry) => !seen.has(entry.id))]
      })

      setCursor(page.nextCursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load more entries.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-4">
      {entries.map((entry, index) => (
        <FeedEntryCard
          key={entry.id}
          {...entry}
          position={index + 1}
        />
      ))}

      {error === null ? null : (
        <p role="alert" className="rounded-control border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {cursor === null ? (
        entries.length === 0 ? null : (
          <p className="py-6 text-center text-sm text-ink-subtle">
            You&rsquo;re all caught up on recent entries.
          </p>
        )
      ) : (
        <button
          type="button"
          // `loadMore` is async and already handles its own errors into `error` state,
          // so the handler just discards the promise — passing it straight through
          // would leave a rejection with nowhere to go.
          onClick={() => {
            void loadMore()
          }}
          disabled={loading}
          className="mx-auto rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
