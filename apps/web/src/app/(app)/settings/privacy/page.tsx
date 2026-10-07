import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

import {
  coerceDurationBand,
  DURATION_CONSENT_COPY,
  type DurationBand,
} from '@fydio/domain'

import { ActivityList, type ActivityRow } from '@/components/privacy/ActivityList'
import { ClearActivityButton } from '@/components/privacy/ClearActivityButton'
import { ConsentToggle } from '@/components/privacy/ConsentToggle'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Privacy | Fydio',
}

export const dynamic = 'force-dynamic'

/**
 * The privacy panel (T08 §5.5).
 *
 * THE ONE PAGE WHERE A MEMBER CAN AUDIT WHAT FYDIO KNOWS ABOUT THEM, and the only
 * place duration data is ever rendered.
 *
 * EVERY READ ON THIS PAGE IS SELF-SCOPED, and none of them takes a member id as an
 * argument:
 *
 *   * `duration_consents` — no `.eq('user_id', …)` at all. RLS admits the caller's
 *     own row and nothing else, so there is no id in the query that could be
 *     pointed elsewhere.
 *   * `duration_events` and `feed_impressions` — same shape, same reason. The
 *     filters that ARE present are entry and ordering, not identity.
 *
 * That is worth stating because the obvious implementation of this page is a
 * `?userId=` search parameter, and it is the obvious implementation that turns a
 * privacy panel into a data-exfiltration endpoint. There is no such parameter here
 * and there is no code path that could accept one.
 *
 * WHY THE CONSENT TEXT IS RENDERED IN FULL. A summary of what is collected is not
 * consent; the member has to be able to read the actual scope before agreeing to
 * it. `DURATION_CONSENT_COPY` is the same string the extension shows (T10), so the
 * two consent surfaces cannot describe different things.
 */
export default async function PrivacySettingsPage() {
  await requireUserId()

  const supabase = await memberClient()

  const { data: consent } = await supabase
    .from('duration_consents')
    .select('consent_version, granted_at, revoked_at')
    .maybeSingle()

  // Revocation is the absence of consent, so a revoked row reads as "off" rather
  // than as an error state. Bumping the consent version in SQL has the same effect
  // for free: the row exists but its version is stale, and this treats it as no
  // grant — which is the behaviour the re-prompt depends on.
  const { data: currentVersion } = await supabase.rpc('current_duration_consent_version')

  const version = typeof currentVersion === 'string' ? currentVersion : null
  const versionIsCurrent = version !== null && consent?.consent_version === version

  const granted = consent !== null && consent.revoked_at === null && versionIsCurrent

  const { data: activity } = await supabase
    .from('feed_impressions')
    .select('entry_id, opened_at, entry:content_entries(id, title, platform)')
    .eq('opened', true)
    .order('opened_at', { ascending: false })
    .limit(25)

  const { data: bands } = await supabase
    .from('duration_events')
    .select('entry_id, band')
    .order('received_at', { ascending: false })
    .limit(200)

  // The newest band per entry. Ordered newest-first above, so the first row
  // encountered for an entry is the most recent one — which is the one worth
  // showing beside that entry's open.
  const bandByEntry = new Map<string, DurationBand>()

  for (const row of bands ?? []) {
    if (bandByEntry.has(row.entry_id)) continue

    // Narrowed through the shared coercion rather than cast: a value the enum does
    // not know must render as "not recorded", never as itself.
    bandByEntry.set(row.entry_id, coerceDurationBand(row.band))
  }

  const rows: ActivityRow[] = (activity ?? []).flatMap((row) => {
    if (row.opened_at === null) return []

    const entry = row.entry as unknown as
      | { id?: string; title?: string | null; platform?: string }
      | null

    if (entry?.id === undefined) return []

    return [
      {
        entryId: entry.id,
        // Normalised rather than passed through: a preview that failed to resolve
        // leaves `title` as an empty string, which `??` would treat as a real title and
        // render as a blank list row.
        title: entry.title !== undefined && entry.title !== null && entry.title.length > 0
          ? entry.title
          : null,
        platformLabel: platformLabel(entry.platform),
        openedAt: row.opened_at,
        band: bandByEntry.get(row.entry_id) ?? null,
      },
    ]
  })

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">Settings</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
        <p className="text-ink-muted">
          What Fydio records about your own activity, and the controls to change it.
        </p>
      </Stack>

      <Card title="Browsing duration">
        <Stack gap={3}>
          <p className="text-sm text-ink-muted">{DURATION_CONSENT_COPY}</p>

          <ConsentToggle
            granted={granted}
            grantedAt={consent?.granted_at ?? null}
          />

          {/* The stale-version case has to be visible, because otherwise a member
              whose grant silently stopped applying would see "off" with no
              explanation and no way to tell it from having never agreed. */}
          {consent !== null && !versionIsCurrent ? (
            <p role="status" className="text-sm text-ink-muted">
              The wording of this consent has changed, so it is off until you turn it
              back on.
            </p>
          ) : null}

          <ClearActivityButton />
        </Stack>
      </Card>

      <ActivityList rows={rows} />

      <Card title="What Fydio never records">
        <Stack gap={2}>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-ink-muted">
            <li>
              What you did on the platform. Fydio opens the original link in a new tab
              and has no way to see that page — and no intention of finding out.
            </li>
            <li>
              How long you stayed, in seconds. Only the rough range above, and only if
              you turn it on.
            </li>
            <li>
              Anything another member can see. Your activity list is readable by you and
              by nobody else, administrators included.
            </li>
            <li>
              Anything that affects your Credits or Reputation. Browsing duration is not
              a reward and not a requirement.
            </li>
          </ul>
        </Stack>
      </Card>
    </main>
  )
}

/**
 * A platform name for the activity list.
 *
 * Falling back to the raw enum value rather than hiding the row: an unrecognised
 * platform is a schema change, and showing "click here to open it" with a missing
 * label is more honest than dropping the member's own history on the floor.
 */
function platformLabel(platform: string | undefined): string {
  if (platform === 'instagram') return 'Instagram'
  if (platform === 'tiktok') return 'TikTok'
  if (platform === 'youtube') return 'YouTube'
  if (platform === 'x') return 'X'

  return platform ?? 'Unknown platform'
}
