import { Card, Stack } from '@fydio/ui'

import { DURATION_BAND_LABELS, type DurationBand } from '@fydio/domain'

/**
 * The viewer's own open history (T08).
 *
 * THE ONLY LIST OF THIS KIND IN THE PRODUCT. It reads `feed_impressions` for the
 * caller — RLS scopes it to `viewer_id = auth.uid()`, and there is no
 * `p_user_id` argument anywhere on this path, so it is not possible to render
 * somebody else's history by passing a different id.
 *
 * WHAT "OPENED" MEANS HERE, IN WORDS. The copy under the heading says it plainly:
 * this is a record that the member activated the link, not a measurement of what
 * they did afterwards. A history list that said "you viewed" would be a claim the
 * data cannot support, and a member reading their own telemetry being misled about
 * themselves is the first place that kind of inaccuracy does damage.
 *
 * WHY DURATIONS APPEAR SEPARATELY AND OPTIONALLY. A duration band exists only for
 * members who granted consent, so the list renders a band when one exists and says
 * nothing when it does not. It never shows a placeholder row for "activity we
 * collected but did not time", because that would imply a measurement exists.
 */
export interface ActivityRow {
  readonly entryId: string
  readonly title: string | null
  readonly platformLabel: string
  readonly openedAt: string
  /** The member's own band for this entry, or null when none was consented. */
  readonly band: DurationBand | null
}

export interface ActivityListProps {
  readonly rows: readonly ActivityRow[]
}

export function ActivityList({ rows }: ActivityListProps) {
  return (
    <Card title="Your activity">
      <Stack gap={3}>
        <p className="text-sm text-ink-muted">
          Entries you have opened from Fydio, with the time you opened them. This
          record means you activated the link — it does not track what you did on
          the platform afterwards, and Fydio cannot see that.
        </p>

        {rows.length === 0 ? (
          <p className="text-sm text-ink-subtle">
            Nothing yet. Entries you open from your feed will appear here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li key={row.entryId} className="flex items-baseline justify-between gap-4 py-3">
                <div className="min-w-0">
                  <a href={`/c/${row.entryId}`} className="truncate font-medium hover:underline">
                    {row.title ?? `${row.platformLabel} post`}
                  </a>
                  <p className="text-xs text-ink-subtle">
                    {row.platformLabel} · opened {formatWhen(row.openedAt)}
                  </p>
                </div>

                {/* A band is shown only when one exists. Absent is rendered as
                    absent rather than as "not recorded", because the second reads
                    as "we measured it and the measurement failed" — which is a
                    different claim, and one this data cannot support. */}
                {row.band === null ? null : (
                  <p className="shrink-0 text-right text-xs text-ink-muted">
                    stayed {DURATION_BAND_LABELS[row.band]}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-ink-subtle">
          Private to you. No other member can see this, and it never affects your
          Credits or Reputation.
        </p>
      </Stack>
    </Card>
  )
}

/**
 * A relative-ish timestamp.
 *
 * Locale-formatted rather than a hand-rolled "3d ago": the locale is already
 * resolved for this member, and hand-rolling relative time is how a date ends up
 * reading "in 2 days" because of a sign error.
 */
function formatWhen(iso: string): string {
  const parsed = new Date(iso)

  if (Number.isNaN(parsed.getTime())) return '—'

  return parsed.toLocaleString()
}
