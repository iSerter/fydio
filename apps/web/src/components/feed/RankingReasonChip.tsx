import { FEED_REASON_LABELS, type FeedReason } from '@fydio/domain'

/**
 * "Why you're seeing this" (T07 §5.2).
 *
 * Deliberately MUTED and small. This is an explainer, not a badge the member is
 * meant to read: the brief asks that members be shown why an item appears, and a
 * chip styled like a status would compete with the content for attention it was
 * only ever meant to annotate. It sits under the card, in the same colour as the
 * timestamp beside it.
 *
 * The label is rendered from `FEED_REASON_LABELS` rather than from the SQL
 * `feed_reason_label` because this is a Server Component path and the map is the
 * type-checked source of truth. `apps/web/test/ranking.regression.test.ts` asserts
 * the two agree, so the SQL copy cannot drift into saying something different.
 */
export function RankingReasonChip({ reason }: { readonly reason: FeedReason }) {
  return (
    <span
      data-reason={reason}
      className="inline-flex items-center gap-1 text-xs text-ink-subtle"
      title="Why this appeared in your feed"
    >
      <span aria-hidden="true" className="text-border">
        &#8226;
      </span>
      {FEED_REASON_LABELS[reason]}
    </span>
  )
}