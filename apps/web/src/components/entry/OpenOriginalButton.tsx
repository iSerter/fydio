'use client'

import { PLATFORM_LABELS, type Platform } from '@fydio/domain'
import { getClientEnv } from '@fydio/env/client'

import { rememberReturnToken } from '@/lib/return-token'
import { recordOutboundClick, type ClickSource } from '@/lib/telemetry'

/**
 * The outbound link (T08).
 *
 * WHAT THIS COMPONENT IS. An `<a>` to the original URL with a click handler that
 * records the open. Nothing else. That restraint is the design: the destination
 * is somebody else's page, so Fydio's control ends at the href.
 *
 * THE HREF IS THE ORIGINAL, UNMODIFIED URL. No `utm_*`, no `?fydio_ref=`, no
 * wrapping, no proxy, no redirect of our own. Fydio does not append tracking
 * parameters to a link on somebody else's platform — that would be putting our
 * identifier on a page we do not control, in front of a member who was told Fydio
 * never mirrors content. This is asserted structurally in
 * `test/telemetry-isolation.test.ts`, because "just one query parameter" is the
 * kind of change that arrives as a well-meant improvement.
 *
 * `rel="noopener noreferrer nofollow"` is not decoration:
 *   * `noopener` — the new tab must not get a handle on `window.opener`, or the
 *     destination could navigate Fydio's tab.
 *   * `noreferrer` — the destination must not learn which Fydio page sent them.
 *   * `nofollow` — the outbound link must not be a vote for somebody else's page.
 *
 * WHY THE CALL IS NOT AWAITED. The browser starts the navigation as soon as the
 * click handler returns; an `await` on a network call inside the handler risks
 * the popup being blocked, because the user-gesture window closes while we wait.
 * So the handler fires the RPC and returns immediately. `void` on the promise
 * makes that explicit to the type checker and to a reader, and the RPC itself is
 * fire-and-forget inside `recordOutboundClick`.
 *
 * WHY THERE IS NO `useTransition`. A transition would mark the pending state for
 * React's concurrent renderer, which is the wrong tool: this is not a state
 * update that should be interruptible, it is a side effect that should not affect
 * rendering at all. Wrapping it in a transition would mark the whole card as
 * pending and dim it while the member is reading the platform they just left.
 */
export interface OpenOriginalButtonProps {
  readonly entryId: string
  readonly platform: Platform
  readonly originalUrl: string
  /** Where this card lives, so the activity list can group clicks by surface. */
  readonly source: ClickSource
  readonly className?: string
}

export function OpenOriginalButton({
  entryId,
  platform,
  originalUrl,
  source,
  className,
}: OpenOriginalButtonProps) {
  return (
    <a
      href={originalUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={() => {
        // Not awaited, not caught here: `recordOutboundClick` resolves to `null` on
        // every failure, so there is nothing for this handler to handle and no way
        // for it to throw into the click.
        void recordOutboundClick(entryId, source).then((click) => {
          // The return token is kept in this tab, because the destination URL
          // cannot carry it. Storing it here is what lets `ReturnPrompt` offer the
          // entry back when the member comes to Fydio again — the whole return leg,
          // without a single byte added to somebody else's link.
          if (click !== null) {
            rememberReturnToken(click.returnToken, PLATFORM_LABELS[platform])
            notifyExtension(entryId, click.returnToken)
          }
        })
      }}
      className={
        className ??
        'inline-flex w-fit items-center gap-1 text-sm font-medium text-brand hover:underline'
      }
    >
      Open on {PLATFORM_LABELS[platform]} &#8599;
      {/* Announced to assistive technology, invisible on screen. The arrow glyph
          reads as "decorative" to a screen reader, which would leave the link's
          purpose ambiguous — a new tab is not the same destination as an in-app
          one, and a member using a screen reader deserves to know that before
          activating it. */}
      <span className="sr-only">(opens in a new tab on {PLATFORM_LABELS[platform]})</span>
    </a>
  )
}

/**
 * Inform the companion extension about an outbound click, if installed and enabled.
 * Swallows any communication error — the extension is optional.
 */
function notifyExtension(entryId: string, returnToken: string): void {
  if (typeof window === 'undefined') return
  const extensionId = getClientEnv().NEXT_PUBLIC_EXTENSION_ID
  if (!extensionId) return

  const chromeObj = (
    window as unknown as { chrome?: { runtime?: { sendMessage?: (...args: unknown[]) => void } } }
  ).chrome
  if (typeof chromeObj?.runtime?.sendMessage === 'function') {
    try {
      chromeObj.runtime.sendMessage(extensionId, {
        type: 'FYDIO_OUTBOUND_CLICK',
        entryId,
        returnToken,
      })
    } catch {
      // Ignored: extension may be uninstalled or disabled
    }
  }
}
