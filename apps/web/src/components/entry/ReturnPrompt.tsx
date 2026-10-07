'use client'

import { useCallback, useEffect, useState } from 'react'

import { readRememberedReturn, forgetReturnToken, type RememberedReturn } from '@/lib/return-token'

/**
 * The return-to-Fydio prompt (T08 §5.2).
 *
 * WHAT IT DOES. Watches for the member coming back to this tab, checks whether the
 * return token it is holding is still good, and — if so — offers the entry back with
 * a feedback prompt.
 *
 * WHY THE TAB HAS TO POLL AT ALL. Fydio opened the original link in a new tab and
 * then has no further contact with the platform page: it cannot observe it closing,
 * cannot know what happened there, and would not want to. The one thing it can
 * observe is the Fydio tab regaining focus, which is the honest signal for "the
 * member is back". `/api/opened/status` answers whether the token is still valid;
 * the prompt appears only if it is.
 *
 * WHY A DELAY BEFORE ASKING. Opening a new tab briefly blurs this one, and a focus
 * listener that fires instantly would treat the click's own blur as a return — so
 * every member would get "Back from YouTube?" while still looking at YouTube. The
 * delay is longer than a tab switch and far shorter than the token's own 30-minute
 * life.
 *
 * WHY THE PROMPT IS A LINK AND NOT A MODAL. A modal that appears on its own,
 * unbidden, is an interruption; a banner offering something is an affordance. The
 * member can ignore it and keep reading their feed, which is the outcome a
 * respectful product wants when it cannot be sure they are even back.
 */
export function ReturnPrompt() {
  const [offer, setOffer] = useState<RememberedReturn | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    const remembered = readRememberedReturn()

    if (remembered === null) return

    // The click's own blur, not a return.
    if (Date.now() - remembered.clickedAt < RETURN_SETTLE_MS) return

    setChecking(true)

    try {
      const response = await fetch(`/api/opened/status?token=${remembered.token}`)

      if (!response.ok) return

      const payload = (await response.json()) as { valid?: boolean; returned?: boolean }

      if (payload.valid !== true || payload.returned === true) {
        // Expired, acknowledged, or somebody else's. Either way this tab has nothing
        // useful to offer, and holding the token would keep re-asking on every focus.
        forgetReturnToken()

        return
      }

      setOffer(remembered)
    } catch {
      // A failed check is not an error the member can act on. The token stays, so
      // the next focus tries again.
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    // Checked on mount as well as on focus: a member who never left this tab (the
    // popup opened in the background) never fires `focus`, and they still deserve
    // the prompt.
    const timer = setTimeout(() => {
      void check()
    }, 0)

    function onFocus() {
      void check()
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [check])

  if (offer === null) return null

  return (
    <div
      role="status"
      className="border-b border-brand/20 bg-brand-soft px-6 py-3 text-sm text-brand"
    >
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
        <span>
          Back from {offer.platformLabel}? Leaving feedback on what you just opened is
          optional.
        </span>

        <a
          href={`/opened/${offer.token}`}
          onClick={() => {
            forgetReturnToken()
          }}
          className="font-medium underline"
        >
          Continue
        </a>

        <button
          type="button"
          onClick={() => {
            forgetReturnToken()
            setOffer(null)
          }}
          className="text-brand/70 underline"
          disabled={checking}
        >
          No thanks
        </button>
      </div>
    </div>
  )
}

/**
 * How long after a click before a blur counts as a return.
 *
 * Five seconds. Long enough that opening a tab does not immediately count as coming
 * back, short enough that a member who reads a post and switches back still sees the
 * prompt within a token's 30-minute life.
 */
const RETURN_SETTLE_MS = 5000
