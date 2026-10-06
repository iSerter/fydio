'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import { PLATFORMS, PLATFORM_LABELS, type Platform } from '@fydio/domain'

/**
 * Platform and tag-pool filters (T07 §5.5).
 *
 * URL state, not component state. The filter has to survive a refresh, be
 * shareable, and — the reason it matters — reset the pagination cursor. A filter
 * held in React state cannot do that last one: the "load more" cursor was computed
 * against the unfiltered ordering, so continuing from it after narrowing to YouTube
 * would page through a position in the wrong total order and skip entries.
 *
 * Because the filters are part of the URL, the Server Component re-reads them and
 * the cursor starts fresh on every filter change, which is the correct behaviour
 * rather than a workaround.
 *
 * `router.replace` rather than `push`: changing a filter is refining one view, not
 * navigating, and a stack of twenty filter states makes the back button useless.
 */
export function FeedFilters({
  tags,
  allTags,
}: {
  /** The hashtag slugs in the active pool, resolved to ids by the server. */
  readonly tags: readonly string[]
  /** The full vocabulary, for offering alternatives. */
  readonly allTags: readonly { readonly id: string; readonly slug: string; readonly usage: number }[]
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const selectedPlatforms = PLATFORMS.filter((platform) =>
    searchParams.getAll('platform').includes(platform),
  )

  function togglePlatform(platform: Platform) {
    const next = new URLSearchParams(searchParams.toString())

    next.delete('platform')
    for (const value of selectedPlatforms.includes(platform)
      ? selectedPlatforms.filter((value) => value !== platform)
      : [...selectedPlatforms, platform]) {
      next.append('platform', value)
    }

    router.replace(next.size === 0 ? '/feed' : `/feed?${next.toString()}`)
  }

  function toggleTag(slug: string) {
    const next = new URLSearchParams(searchParams.toString())
    const active = next.getAll('tag')

    next.delete('tag')
    for (const value of active.includes(slug)
      ? active.filter((value) => value !== slug)
      : [...active, slug]) {
      next.append('tag', value)
    }

    router.replace(next.size === 0 ? '/feed' : `/feed?${next.toString()}`)
  }

  function clear() {
    router.replace('/feed')
  }

  const filtered = selectedPlatforms.length > 0 || tags.length > 0

  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Feed filters">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Platform</span>

        {PLATFORMS.map((platform) => {
          const active = selectedPlatforms.includes(platform)

          return (
            <button
              key={platform}
              type="button"
              aria-pressed={active}
              onClick={() => { togglePlatform(platform); }}
              className={
                active
                  ? 'rounded-full border border-brand bg-brand-soft px-3 py-1 text-xs font-medium text-brand'
                  : 'rounded-full border border-border bg-surface px-3 py-1 text-xs text-ink-muted hover:bg-surface-muted'
              }
            >
              {PLATFORM_LABELS[platform]}
            </button>
          )
        })}
      </div>

      {/* The tag pool. Rendered from the seeded vocabulary's most-used tags rather
          than every tag, because a 40-chip row is a filter nobody reads. The cap is
          a presentational choice and is documented here so it is not mistaken for a
          product limit. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">Tags</span>

        {allTags.slice(0, 12).map((tag) => {
          const active = tags.includes(tag.slug)

          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={active}
              onClick={() => { toggleTag(tag.slug); }}
              className={
                active
                  ? 'rounded-full border border-brand bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand'
                  : 'rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-ink-muted hover:bg-surface-muted'
              }
            >
              #{tag.slug}
            </button>
          )
        })}

        {filtered ? (
          <button
            type="button"
            onClick={clear}
            className="text-xs text-brand underline underline-offset-2 hover:opacity-80"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  )
}