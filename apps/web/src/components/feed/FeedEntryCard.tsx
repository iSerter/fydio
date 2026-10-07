import { type FeedReason, type Platform } from '@fydio/domain'

import { OpenOriginalButton } from '@/components/entry/OpenOriginalButton'
import { PlatformBadge } from '@/components/entry/PlatformBadge'
import { TuningMenu } from '@/components/feed/TuningMenu'

import { RankingReasonChip } from './RankingReasonChip'

/**
 * The feed card (T07 §5.6, brief §4).
 *
 * A Server Component that composes `EntryCard`'s parts rather than reimplementing
 * them. `EntryCard` is already the agreed rendering of a submitted post — thumbnail
 * or link card, platform badge, tag triplet, outbound link — and a second version
 * of it in the feed is exactly the kind of duplication that makes two screens
 * disagree about what an entry is.
 *
 * WHAT IS ADDED OVER `EntryCard`, and why each is here:
 *
 *   * The creator's identity. A feed without an author is a list of links, and
 *     "from someone you're connected to" is the whole point of the friend signal.
 *   * The ranking reason. The brief's principle 4 is that members be told why an
 *     item appears; a card that omits it fails the product regardless of how well
 *     it ranks.
 *   * The tuning menu. Ranking without recourse to correct it is a black box with a
 *     score attached.
 *
 * NOT HERE: click tracking inline. T08 replaces the plain anchor with
 * `OpenOriginalButton`, which is that same anchor plus a click handler — the
 * recording lives in one component shared with the entry page and profile lists,
 * so a third surface cannot grow its own copy of the telemetry logic and drift
 * from it.
 *
 * STORAGE URLS ARRIVE RESOLVED, NOT AS KEYS. `avatarBucket`/`coversBucket` live in
 * `@/lib/env`, which is `server-only` — a module that reads `STORAGE_BUCKET_*` from
 * the server environment. This card renders inside `FeedClient`, a Client Component,
 * and importing `server-only` from one is a build error rather than a runtime
 * surprise. So the bucket names and `SUPABASE_URL` are resolved on the server and the
 * card receives finished absolute URLs.
 *
 * That is also the correct boundary rather than a workaround: an absolute Storage URL
 * is what an `<img src>` needs, and resolving it once on the server is cheaper than
 * making every consumer re-derive it.
 */

export interface FeedEntryCardProps {
  readonly id: string
  readonly platform: Platform
  readonly originalUrl: string
  readonly title: string | null
  readonly caption: string | null
  /**
   * The cover image, already resolved to an absolute URL by the server.
   *
   * `null` means there is no image at all and the link-card fallback renders.
   */
  readonly coverUrl: string | null
  readonly creatorNote: string | null
  readonly asksForFeedback: boolean
  readonly publishedAt: string
  readonly reason: FeedReason
  readonly tags: readonly { readonly id: string; readonly slug: string; readonly label: string }[]
  readonly author: {
    readonly id: string
    readonly handle: string
    readonly displayName: string
    /** Resolved absolute avatar URL, or `null`. */
    readonly avatarUrl: string | null
  }
  /**
   * The card's 1-based slot, assigned by the list at render time.
   *
   * A render-time prop rather than part of the entry because the slot changes when a
   * card above it is removed — and the impression metric is bucketed by what the
   * member actually saw, not by what the ranker served.
   */
  readonly position: number
}

export function FeedEntryCard(props: FeedEntryCardProps) {
  return (
    <article
      data-entry-id={props.id}
      data-position={props.position}
      className="flex flex-col gap-3 overflow-hidden rounded-card border border-border bg-surface"
    >
      {props.coverUrl === null ? (
        <LinkCardFallback platform={props.platform} host={hostOf(props.originalUrl)} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={props.coverUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="aspect-[1200/630] w-full object-cover"
        />
      )}

      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            {props.author.avatarUrl === null ? null : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={props.author.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="h-6 w-6 rounded-full object-cover"
              />
            )}
            <a
              href={`/u/${props.author.handle}`}
              className="text-sm font-medium text-ink hover:underline"
            >
              {props.author.displayName}
            </a>
            <span className="text-xs text-ink-subtle">@{props.author.handle}</span>
          </div>

          <TuningMenu
            entryId={props.id}
            authorId={props.author.id}
            authorHandle={props.author.handle}
          />
        </div>

        <div className="flex items-center gap-2">
          <PlatformBadge platform={props.platform} />
          <span className="text-xs text-ink-subtle">{hostOf(props.originalUrl)}</span>
        </div>

        {props.title === null ? null : (
          <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2>
        )}
        {props.caption === null ? null : (
          <p className="text-sm text-ink-muted">{props.caption}</p>
        )}

        <TagTriplet tags={props.tags} />

        {props.creatorNote === null ? null : (
          <p className="rounded-control bg-surface-muted px-3 py-2 text-sm text-ink">
            {props.creatorNote}
          </p>
        )}

        {props.asksForFeedback ? (
          <p className="text-xs font-medium text-brand">This creator is asking for feedback.</p>
        ) : null}

        <OpenOriginalButton
          entryId={props.id}
          platform={props.platform}
          originalUrl={props.originalUrl}
          source="feed"
        />

        {/* The transparency line. `publishedAt` and the reason sit together at the
            bottom because they answer the same question — "why am I looking at this,
            and why now" — and separating them across the card would make the member
            assemble it themselves. */}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-xs text-ink-subtle">{relativeTime(props.publishedAt)}</span>
          <RankingReasonChip reason={props.reason} />
        </div>
      </div>
    </article>
  )
}

function TagTriplet({ tags }: { readonly tags: FeedEntryCardProps['tags'] }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Entry hashtags">
      {tags.map((tag) => (
        <a
          key={tag.id}
          href={`/feed?tag=${encodeURIComponent(tag.slug)}`}
          className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-ink hover:bg-surface"
        >
          #{tag.slug}
        </a>
      ))}
    </div>
  )
}

function LinkCardFallback({ platform, host }: { readonly platform: Platform; readonly host: string }) {
  return (
    <div className="flex aspect-[1200/630] w-full flex-col items-center justify-center gap-2 bg-surface-muted p-6 text-center">
      <PlatformBadge platform={platform} />
      <p className="text-sm font-medium text-ink">No preview available</p>
      <p className="max-w-md truncate text-xs text-ink-subtle">{host}</p>
    </div>
  )
}

/**
 * The host of the original URL, for display.
 *
 * Parsed rather than concatenated, and reduced to `host` — never shown as a raw
 * URL. A member reading their own feed should not have their attention caught by a
 * tracking parameter, and the display host is what tells them which platform the
 * post actually lives on.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    // A URL that will not parse is already a problem the submission path rejects.
    // Showing the raw string is worse than useless here but is not a crash.
    return url.slice(0, 60)
  }
}

/**
 * A coarse relative time.
 *
 * `Intl.RelativeTimeFormat` with explicit units rather than a hand-rolled "5m ago":
 * it handles the pluralisation and the "yesterday" case that a naive
 * `n > 1 ? 's' : ''` gets wrong, and it is the same string for every locale rather
 * than one hard-coded to English.
 *
 * Only four units, because the freshness window is 720 hours — an entry older than
 * 30 days is not in the feed, so "last month" can never be the honest answer.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso)

  if (Number.isNaN(then)) return ''

  const hours = (Date.now() - then) / (1000 * 60 * 60)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  if (hours < 1) return formatter.format(-Math.max(1, Math.round(hours * 60)), 'minute')
  if (hours < 24) return formatter.format(-Math.round(hours), 'hour')
  if (hours < 24 * 30) return formatter.format(-Math.round(hours / 24), 'day')

  return formatter.format(-Math.round(hours / (24 * 30)), 'month')
}