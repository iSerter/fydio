'use client'

import { useState } from 'react'

import { DURATION_CONSENT_DISCLAIMER } from '@fydio/domain'

import { setDurationConsent } from '@/app/(app)/settings/privacy/actions'

/**
 * The duration-consent control (T08).
 *
 * A checkbox, not a fancy switch. This is a consent decision about data
 * collection, and the affordance should look like the plain question it is: "may
 * Fydio record this?" A toggle styled like a preference for dark mode reads as a
 * cosmetic choice; a checkbox with an explicit label does not.
 *
 * WHY THE SCOPE TEXT SITS UNDER THE CONTROL AND NOT ONLY ON THE PAGE. A member who
 * arrives here from a link or a search has not read the page heading. The
 * consequence of the control has to travel with the control.
 *
 * THE STATE IS THE SERVER'S. `granted` comes from the page's read of
 * `duration_consents`, and the action re-reads and re-writes in SQL. The optimistic
 * update below is immediacy only: if the action fails, the checkbox returns to
 * what the server says, because a consent control that displays the wrong state is
 * worse than one that lags by a round trip.
 */
export interface ConsentToggleProps {
  /** The server's current answer. Never a guess. */
  readonly granted: boolean
  /** When the current grant started, or null when there is none. */
  readonly grantedAt: string | null
}

export function ConsentToggle({ granted, grantedAt }: ConsentToggleProps) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)

  const isChecked = optimistic ?? granted

  async function toggle(next: boolean) {
    setBusy(true)
    setMessage(null)
    setOptimistic(next)

    try {
      const result = await setDurationConsent(next)

      if (!result.ok) {
        setOptimistic(null)
        setMessage(result.message ?? 'That change could not be saved.')

        return
      }

      setOptimistic(null)
    } catch (error) {
      setOptimistic(null)
      setMessage(error instanceof Error ? error.message : 'That change could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={isChecked}
          disabled={busy}
          onChange={(event) => {
            void toggle(event.target.checked)
          }}
          className="mt-0.5 h-4 w-4 accent-brand"
        />
        <span>
          Record how long I keep a Fydio-opened tab active, as a rough range
          {isChecked && grantedAt !== null ? (
            <span className="text-ink-subtle"> — on since {formatDate(grantedAt)}</span>
          ) : null}
        </span>
      </label>

      <p className="text-xs text-ink-muted">{DURATION_CONSENT_DISCLAIMER}</p>

      {message !== null ? (
        <p role="alert" className="text-sm text-critical">
          {message}
        </p>
      ) : null}
    </div>
  )
}

/** A date in the member's locale, or a dash. Invalid dates render as a dash. */
function formatDate(value: string): string {
  const parsed = new Date(value)

  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString()
}
