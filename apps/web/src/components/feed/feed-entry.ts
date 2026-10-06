import type { FeedReason, Platform } from '@fydio/domain'
import type { FeedEntryParsed } from '@fydio/supabase'

/**
 * The card-shaped view of a ranked row, with the jsonb payload already unwrapped and
 * Storage keys already resolved.
 *
 * THIS MODULE IS SERVER-SAFE. It has no `'use client'` directive, and the two modules
 * that import it — the `/feed` Server Component and `FeedClient` — do so for different
 * reasons: the page maps the first page here, and the client maps later pages. If it
 * lived in `FeedClient.tsx` the mapping would carry the Client Component marker with
 * it, and the server calling it would be a build-time error rather than a runtime
 * surprise.
 */

/** The card-shaped view of a ranked row. */
export interface FeedCardEntry {
  readonly id: string
  /** The ranker's score, exact text. Numeric only where the UI displays or sends it. */
  readonly score: string
  readonly reason: FeedReason
  readonly platform: Platform
  readonly originalUrl: string
  readonly title: string | null
  readonly caption: string | null
  /** Absolute cover image URL, resolved on the server. `null` renders the link card. */
  readonly coverUrl: string | null
  readonly creatorNote: string | null
  readonly asksForFeedback: boolean
  readonly publishedAt: string
  readonly author: {
    readonly id: string
    readonly handle: string
    readonly displayName: string
    /** Absolute avatar URL, resolved on the server. */
    readonly avatarUrl: string | null
  }
  readonly tags: readonly { readonly id: string; readonly slug: string; readonly label: string }[]
}

export interface FeedCardCursor {
  /** Exact text from the ranker — see `FeedCursor` in `../(app)/feed/actions` for why. */
  readonly score: string
  readonly publishedAt: string
  readonly id: string
}

/**
 * Map a parsed `rank_feed` payload into card props.
 *
 * Takes the RESOLVED cover and avatar URLs rather than Storage keys, because resolving
 * them needs `STORAGE_BUCKET_*` from `@/lib/env`, which is `server-only`. That work
 * happens on the server and the finished URLs travel in.
 *
 * An explicit mapping rather than a spread, so a field added to the SQL payload shows
 * up here as a decision rather than arriving silently on a card.
 */
export function toCardEntry(input: {
  readonly payload: FeedEntryParsed
  readonly score: string
  readonly reason: FeedReason
  readonly coverUrl: string | null
  readonly avatarUrl: string | null
}): FeedCardEntry {
  return {
    id: input.payload.id,
    score: input.score,
    reason: input.reason,
    platform: input.payload.platform,
    originalUrl: input.payload.originalUrl,
    title: input.payload.title,
    // `captionExcerpt` in the jsonb, `caption` on the card. The rename happens at the
    // boundary rather than leaking into the component, where T04's `EntryCard` already
    // established `caption` as the prop name.
    caption: input.payload.captionExcerpt,
    coverUrl: input.coverUrl,
    creatorNote: input.payload.creatorNote,
    asksForFeedback: input.payload.asksForFeedback,
    publishedAt: input.payload.publishedAt,
    author: {
      id: input.payload.author.id,
      handle: input.payload.author.handle,
      displayName: input.payload.author.displayName,
      avatarUrl: input.avatarUrl,
    },
    tags: input.payload.tags,
  }
}