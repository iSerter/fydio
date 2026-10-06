'use client'

import { useState } from 'react'

import { setCreatorMuted, submitFeedSignal } from '@/app/(app)/feed/actions'

/**
 * The per-card tuning controls (T07 §5.5).
 *
 * A `<details>` disclosure rather than a popover or a custom menu: it is keyboard
 * accessible and screen-reader labelled with no ARIA to get wrong, and it renders
 * nothing at all until asked for — which is what keeps four actions off every card
 * in a twenty-card feed.
 *
 * WHY EACH CONTROL EXISTS:
 *
 *   More like this — boosts entries sharing this entry's hashtags.
 *   Less like this — removes it. Not "ranks it lower": a penalty strong enough to
 *     hide something is a hide wearing a disguise, and the member cannot tell which
 *     one they pressed.
 *   Hide — same effect, kept as a separate verb because it is the one people reach
 *     for when the CONTENT is the problem rather than the topic.
 *   Mute creator — hides everything by this person. A preference, not a block.
 *
 * All four affect only Fydio's recommendations. None of them touches the creator,
 * the platform, or any external system, and the copy below says so — a member
 * hiding a post should not have to wonder whether the creator was told.
 */
export function TuningMenu({
  entryId,
  authorId,
  authorHandle,
}: {
  readonly entryId: string
  readonly authorId: string
  readonly authorHandle: string
}) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run(
    action: () => Promise<{ ok: boolean; message?: string }>,
    removes: { readonly entry?: boolean; readonly author?: boolean },
  ) {
    setPending(true)
    setMessage(null)

    try {
      const result = await action()

      if (!result.ok) {
        setMessage(result.message ?? 'That did not work. Please try again.')

        return
      }

      // On success there is deliberately no confirmation to show: either the card is
      // gone or the feed re-ranks, so a message would announce something the member
      // can already see.
      //
      // `revalidatePath('/feed')` only affects the NEXT server render, and this list
      // is client state — so a removal is announced to the list, which drops the card
      // immediately. Without this the member presses Hide and nothing visibly happens
      // until they reload, which reads as a broken control.
      //
      // A mute removes by AUTHOR rather than by entry: every card by that creator
      // goes, not just the one whose menu was opened. The server remains the
      // authority — this is immediacy, and the next navigation renders the true state.
      if (removes.entry === true) {
        document.dispatchEvent(new CustomEvent<string>('fydio:feed-remove', { detail: entryId }))
      }

      if (removes.author === true) {
        document.dispatchEvent(
          new CustomEvent<string>('fydio:feed-remove-author', { detail: authorId }),
        )
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That did not work. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <details className="relative">
      <summary
        aria-label={`Tune this entry from @${authorHandle}`}
        className="inline-flex cursor-pointer list-none items-center rounded-control px-2 py-1 text-xs text-ink-subtle hover:bg-surface-muted hover:text-ink"
      >
        Tune
      </summary>

      <div className="absolute right-0 z-10 mt-1 w-56 rounded-card border border-border bg-surface p-2 shadow-lg">
        <div className="flex flex-col">
          <MenuButton
            disabled={pending}
            onSelect={() => run(() => submitFeedSignal(entryId, 'more_like'), {})}
            label="More like this"
            hint="Show more entries with these hashtags"
          />
          <MenuButton
            disabled={pending}
            onSelect={() => run(() => submitFeedSignal(entryId, 'less_like'), { entry: true })}
            label="Less like this"
            hint="Remove this from your feed"
          />
          <MenuButton
            disabled={pending}
            onSelect={() => run(() => submitFeedSignal(entryId, 'hide'), { entry: true })}
            label="Hide this"
            hint="Stop showing me this entry"
          />
          <MenuButton
            disabled={pending}
            onSelect={() => run(() => setCreatorMuted(authorId, true), { author: true })}
            label={`Mute @${authorHandle}`}
            hint="Stop showing me this creator's entries"
          />

          <p className="mt-2 border-t border-border px-2 pt-2 text-[0.6875rem] leading-relaxed text-ink-subtle">
            These change what Fydio recommends to you. They are not sent to the creator or to
            the platform.
          </p>

          {message === null ? null : (
            <p role="alert" className="mt-1 px-2 text-xs text-danger">
              {message}
            </p>
          )}
        </div>
      </div>
    </details>
  )
}

function MenuButton({
  label,
  hint,
  disabled,
  onSelect,
}: {
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly onSelect: () => Promise<void>
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      // Braced and `void`-ed rather than `onClick={onSelect}`: React expects a void
      // handler, and passing the promise-returning function straight through both
      // trips `no-misused-promises` and leaves a rejection with nowhere to go.
      onClick={() => {
        void onSelect()
      }}
      // `data-action` is a stable hook for the E2E suite. Deriving it from the label
      // rather than hardcoding a second string means the selector and the text a
      // member reads cannot drift apart.
      data-action={label.toLowerCase().split(' ').slice(0, 2).join('-')}
      className="flex flex-col items-start gap-0.5 rounded-control px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
    >
      <span>{label}</span>
      <span className="text-[0.6875rem] text-ink-subtle">{hint}</span>
    </button>
  )
}