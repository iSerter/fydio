import { PLATFORM_LABELS, type Platform } from '@fydio/domain'

/**
 * Platform badge (T04). Text only — no brand assets, no embeds.
 */
export function PlatformBadge({ platform }: { readonly platform: Platform }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink">
      {PLATFORM_LABELS[platform]}
    </span>
  )
}
