'use client'

import { useEffect, useMemo, useState } from 'react'

import { MAX_PROFILE_HASHTAGS, normalizeHashtagSlug } from '@fydio/domain'
import { Badge, Button, Card, Stack } from '@fydio/ui'

/**
 * The five-slot hashtag picker (T03).
 *
 * Step 4 of onboarding is the highest-friction screen in the product: it is the only step a
 * member CANNOT finish without making a considered choice, and it is the step the feed depends
 * on ("the primary matching signal for your home feed"). So the affordances here exist to make
 * a valid state reachable in one pass:
 *
 *   - suggestions rank by `usage_count DESC` (server side), so the most-used tags come first;
 *   - a live "n of 5" counter, so the cap is never a surprise;
 *   - search DISABLES at five, because there is nothing left to add;
 *   - typed text can be created as a new tag, with the cap enforced server-side too.
 *
 * THE CAP IS ENFORCED IN THREE PLACES, and that is deliberate:
 *
 *   1. HERE -- a sixth selection is impossible, because `toggle` refuses it and the field
 *      disables. This is the only one a member experiences.
 *   2. `set_profile_hashtags` (0012) -- refuses more than five server-side.
 *   3. The deferred constraint trigger (0002) -- refuses more than five rows at COMMIT, for
 *      any caller including service-role code.
 *
 * Only (1) is a convenience. (3) is the invariant.
 */

export interface HashtagOption {
  readonly id: string
  readonly slug: string
  readonly label: string
  readonly usage_count: number
  readonly is_official: boolean
}

export interface HashtagPickerProps {
  readonly selected: readonly HashtagOption[]
  readonly onChange: (next: HashtagOption[]) => void
  /** How many may be chosen. Overridable so /settings/profile can allow fewer. */
  readonly limit?: number
}

export function HashtagPicker({
  selected,
  onChange,
  limit = MAX_PROFILE_HASHTAGS,
}: HashtagPickerProps) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<HashtagOption[]>([])
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const full = selected.length >= limit

  // The search field is disabled at the cap. Not merely ignored: a member who has five tags
  // and cannot see why the box stopped responding has no way to know they must remove one.
  const searchDisabled = full || creating

  // Debounced. Without it every keystroke fires a request, and the picker is the screen a new
  // member spends the longest on. Keyed on `query` only; `full` gates whether it runs at all.
  useEffect(() => {
    if (full) return

    const handle = setTimeout(() => {
      // The fetch is inside an async IIFE rather than the timeout callback being `async`
      // itself: `setTimeout` expects a `void`-returning callback, and an async one is a
      // floating promise the linter is right to refuse.
      void (async () => {
        const response = await fetch(`/api/hashtags?q=${encodeURIComponent(query)}`)

        if (!response.ok) return

      const payload: unknown = await response.json().catch(() => null)

        setSuggestions(readHashtags(payload))
      })()
    }, 200)

    return () => {
      clearTimeout(handle)
    }
  }, [query, full])

  const typedSlug = useMemo(() => normalizeHashtagSlug(query), [query])

  /**
   * Whether the typed text is a tag that does not exist yet.
   *
   * Compared against the suggestion list rather than asked of the server, so the affordance
   * appears immediately. `create_hashtag` is idempotent anyway, so offering the button for an
   * existing tag costs nothing but a redundant round trip that returns the existing row.
   */
  const canCreate =
    typedSlug !== null &&
    !suggestions.some((tag) => tag.slug === typedSlug) &&
    selected.length < limit &&
    query.trim() !== ''

  function toggle(tag: HashtagOption) {
    if (selected.some((chosen) => chosen.id === tag.id)) {
      onChange(selected.filter((chosen) => chosen.id !== tag.id))
      setNotice(null)
      return
    }

    // The cap, enforced here so a sixth selection is not merely rejected later but never
    // possible to express.
    if (selected.length >= limit) {
      setNotice('Five hashtags is the maximum — remove one to swap.')
      return
    }

    onChange([...selected, tag])
    setNotice(null)
    setQuery('')
  }

  async function createTyped() {
    // `canCreate` already requires a non-null `typedSlug`, so this does not re-check it. The
    // two would be separate conditions on the same state, and the one that could be dropped
    // by a future edit is exactly the one that would then throw.
    if (!canCreate) return

    setCreating(true)
    setNotice(null)

    try {
      const response = await fetch('/api/hashtags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: query.trim() }),
      })

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setNotice(readError(payload) ?? 'That hashtag could not be created.')
        return
      }

      const created = readHashtags({ hashtag: readHashtag(payload) })
      const [first] = created

      if (first !== undefined) {
        onChange([...selected, first])
        setQuery('')
      }
    } finally {
      setCreating(false)
    }
  }

  const remaining = limit - selected.length
return (
    <Card title="Your hashtags">
      <Stack gap={4}>
        <p className="text-sm text-ink-muted">
          Describe your expertise or interests — these drive what appears in your feed, so
          choose the ones that describe what you actually make.
        </p>

        <Stack gap={2}>
          <label className="text-sm font-medium text-ink" htmlFor="hashtag-search">
            Search or create a hashtag
          </label>
          <input
            id="hashtag-search"
            type="search"
            value={query}
            disabled={searchDisabled}
            onChange={(event) => { setQuery(event.target.value); }}
            placeholder={
              full
                ? 'Five hashtags is the maximum — remove one to swap'
                : 'e.g. hooks, editing, storytelling'
            }
            className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
          />
        </Stack>

        <Stack gap={2}>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Selected hashtags"
          >
            {selected.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => { toggle(tag); }}
                className="inline-flex items-center gap-1 rounded-full border border-brand/20 bg-brand-soft px-3 py-1 text-xs font-medium text-brand"
              >
                #{tag.slug}
                <span aria-hidden="true">×</span>
                <span className="sr-only">Remove {tag.label}</span>
              </button>
            ))}

            {selected.length === 0 ? (
              <span className="text-xs text-ink-subtle">Nothing selected yet</span>
            ) : null}
          </div>

          <p className="text-sm font-medium text-ink-muted" aria-live="polite">
            {selected.length} of {limit} selected
            {remaining > 0 ? ` — ${remaining} to go` : ''}
          </p>
        </Stack>

        {canCreate ? (
          <Button variant="secondary" onClick={() => { void createTyped(); }} disabled={creating}>
            {creating ? 'Creating…' : `Create #${typedSlug}`}
          </Button>
        ) : null}

        {!full ? (
          // Named, because the two lists of `#`-prefixed buttons are otherwise indistinguishable
          // to a screen reader -- and to anything else driving the UI, which is the other half of
          // why a name here is not a test-only affordance.
          <ul className="flex flex-wrap gap-2" aria-label="Suggested hashtags">
            {suggestions
              .filter((tag) => !selected.some((chosen) => chosen.id === tag.id))
              .map((tag) => (
                <li key={tag.id}>
                  <button
                    type="button"
                    onClick={() => { toggle(tag); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted px-3 py-1 text-xs text-ink hover:bg-surface"
                  >
                    #{tag.slug}
                    {tag.is_official ? <Badge tone="brand">official</Badge> : null}
                  </button>
                </li>
              ))}
          </ul>
        ) : null}

        {notice ? (
          <p role="status" className="text-sm text-ink-muted">
            {notice}
          </p>
        ) : null}
      </Stack>
    </Card>
  )
}

/** Narrow a response body to the hashtag array, tolerating a missing or malformed body. */
function readHashtags(payload: unknown): HashtagOption[] {
  if (typeof payload !== 'object' || payload === null) return []

  const rows = (payload as { hashtags?: unknown }).hashtags

  return Array.isArray(rows) ? rows.filter(isHashtag) : []
}

/** Read the single `hashtag` returned by the create endpoint. */
function readHashtag(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return null
  return (payload as { hashtag?: unknown }).hashtag
}

function isHashtag(value: unknown): value is HashtagOption {
  if (typeof value !== 'object' || value === null) return false

  const row = value as Partial<HashtagOption>

  return (
    typeof row.id === 'string' &&
    typeof row.slug === 'string' &&
    typeof row.label === 'string' &&
    typeof row.usage_count === 'number' &&
    typeof row.is_official === 'boolean'
  )
}

function readError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null

  const error = (payload as { error?: unknown }).error

  return typeof error === 'string' ? error : null
}