'use client'

import { MAX_BIO_CHARS } from '@fydio/domain'
import { Card, Stack } from '@fydio/ui'

/**
 * The short bio field (T03).
 *
 * A plain textarea with a live character counter, rather than a rich editor. A bio is two or
 * three sentences at most; anything with formatting affordances would invite writing that
 * does not fit a profile card.
 *
 * The counter turns amber as the limit approaches and the field is marked `aria-invalid` once
 * over it, so the limit is visible before submitting rather than reported afterwards. The
 * limit itself is enforced in `bioSchema` (domain) and by the caller (server), so exceeding it
 * here is caught twice.
 */
export interface BioFieldProps {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly error?: string | undefined
}

export function BioField({ value, onChange, error }: BioFieldProps) {
  const remaining = MAX_BIO_CHARS - value.length
  const over = remaining < 0
  // Amber inside the limit only once the member is close enough that the number matters.
  const near = !over && remaining <= 40

  return (
    <Card title="Short bio">
      <Stack gap={2}>
        <label className="text-sm font-medium text-ink" htmlFor="bio">
          A sentence or two about what you make
        </label>
        <textarea
          id="bio"
          rows={3}
          value={value}
          maxLength={MAX_BIO_CHARS + 40}
          aria-invalid={over}
          aria-describedby="bio-counter"
          onChange={(event) => { onChange(event.target.value); }}
          placeholder="Filmmaker working on short-form documentaries. Mostly lighting and sound."
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand aria-[invalid=true]:border-critical"
        />

        <p
          id="bio-counter"
          aria-live="polite"
          className={`text-xs ${over ? 'text-critical' : near ? 'text-warning' : 'text-ink-subtle'}`}
        >
          {over
            ? `${-remaining} characters over the limit`
            : `${remaining} characters left`}
        </p>

        {error ? (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        ) : null}
      </Stack>
    </Card>
  )
}