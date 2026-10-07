import { displayHost, type Platform } from '@fydio/domain'

import { OpenOriginalButton } from './OpenOriginalButton'
import { PlatformBadge } from './PlatformBadge'

/**
 * Entry card (T04): thumbnail when resolved, platform-branded link card otherwise.
 *
 * The outbound link is ALWAYS the original URL the member submitted, with
 * `target="_blank" rel="noopener noreferrer nofollow"`. Fydio never proxies,
 * embeds, or mirrors the content. External thumbnails render with
 * `referrerPolicy="no-referrer"` — the URL is stored, not proxied.
 *
 * T08 replaced the inline `<a>` with `OpenOriginalButton`, which is the same
 * anchor plus click recording. The href is untouched: the recording happens in
 * the click handler, never in the URL.
 */

export interface EntryTag {
  readonly id: string
  readonly slug: string
}

export interface EntryCardProps {
  /** Needed to record the click; the card has no identity without it. */
  readonly entryId: string
  readonly platform: Platform
  readonly originalUrl: string
  readonly title: string | null
  readonly caption: string | null
  readonly thumbnailSource: string | null
  readonly coverUrl: string | null
  readonly previewState: string
  readonly hashtags: readonly EntryTag[]
  readonly creatorNote: string | null
  readonly asksForFeedback: boolean
}

export function EntryCard(props: EntryCardProps) {
  const image = props.coverUrl ?? props.thumbnailSource

  return (
    <article className="overflow-hidden rounded-card border border-border bg-surface">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          className="aspect-[1200/630] w-full object-cover"
        />
      ) : (
        <LinkCardFallback platform={props.platform} originalUrl={props.originalUrl} />
      )}

      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-center gap-2">
          <PlatformBadge platform={props.platform} />
          <span className="text-xs text-ink-subtle">{displayHost(props.originalUrl)}</span>
        </div>

        {props.title ? <h2 className="text-lg font-semibold tracking-tight">{props.title}</h2> : null}
        {props.caption ? <p className="text-sm text-ink-muted">{props.caption}</p> : null}

        <TagTriplet tags={props.hashtags} />

        {props.creatorNote ? (
          <p className="rounded-control bg-surface-muted px-3 py-2 text-sm text-ink">{props.creatorNote}</p>
        ) : null}

        {props.asksForFeedback ? (
          <p className="text-xs font-medium text-brand">This creator is asking for feedback.</p>
        ) : null}

        <OpenOriginalButton
          entryId={props.entryId}
          platform={props.platform}
          originalUrl={props.originalUrl}
          source="entry_page"
        />
        <p className="text-xs text-ink-subtle">Opens on the original platform. Fydio never mirrors content.</p>
      </div>
    </article>
  )
}

export function TagTriplet({ tags }: { readonly tags: readonly EntryTag[] }) {
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

export function LinkCardFallback({
  platform,
  originalUrl,
}: {
  readonly platform: Platform
  readonly originalUrl: string
}) {
  return (
    <div className="flex aspect-[1200/630] w-full flex-col items-center justify-center gap-2 bg-surface-muted p-6 text-center">
      <PlatformBadge platform={platform} />
      <p className="text-sm font-medium text-ink">No preview available</p>
      <p className="max-w-md truncate text-xs text-ink-subtle">{displayHost(originalUrl)}</p>
    </div>
  )
}
