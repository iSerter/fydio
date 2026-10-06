import { MAX_RATING, MIN_RATING } from '@fydio/domain'

/**
 * Read-only star display (T06).
 *
 * Renders a 1–10 rating as filled/empty stars. Display-only: the interactive
 * rating input (modal + inbox) lands in T09. Out-of-range values render nothing
 * rather than clamping — a bad number is a data error the caller should see.
 */
export function RatingStars({ score }: { readonly score: number }) {
  if (!Number.isInteger(score) || score < MIN_RATING || score > MAX_RATING) return null

  return (
    <span
      role="img"
      aria-label={`Rated ${score} out of ${MAX_RATING}`}
      className="text-sm tracking-tight"
    >
      {'★'.repeat(score)}
      <span aria-hidden="true" className="text-ink-subtle">
        {'★'.repeat(MAX_RATING - score)}
      </span>
    </span>
  )
}
