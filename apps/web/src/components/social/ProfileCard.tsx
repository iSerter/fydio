import Image from 'next/image'

import { Badge, Card, Stack } from '@fydio/ui'

import { REPUTATION_LABEL } from '@fydio/domain'

/**
 * A member summary (T03).
 *
 * A Server Component: a profile card appears many times per feed page and needs no state, so
 * making it a Client Component would ship its props and hydration cost to every reader for no
 * benefit.
 *
 * REPUTATION IS A PLACEHOLDER HERE ON PURPOSE. T06 owns the reputation ledger and T09 builds the
 * real display. Showing the number now would imply a scoring system that does not exist yet, so
 * the card carries the member's identity and hashtags only.
 */
export interface ProfileCardData {
  readonly handle: string
  readonly display_name: string
  readonly bio: string | null
  readonly avatar_path: string | null
  readonly hashtags: readonly { slug: string; label: string }[]
}

export interface ProfileCardProps {
  readonly profile: ProfileCardData
  /** Storage base for avatar URLs. Absent in contexts that have no session. */
  readonly avatarBaseUrl?: string
}

export function ProfileCard({ profile, avatarBaseUrl }: ProfileCardProps) {
  // `next/image` with `unoptimized`: these are public Storage objects already stored as 512px
  // WebP under 200 KB, so the optimiser has nothing to add and would only add a hop.
  return (
    <Card>
      <Stack gap={3}>
        <div className="flex items-center gap-3">
          {profile.avatar_path !== null && avatarBaseUrl !== undefined ? (
            <Image
              src={`${avatarBaseUrl}/${profile.avatar_path}`}
              alt=""
              width={48}
              height={48}
              unoptimized
              className="h-12 w-12 rounded-full border border-border object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="h-12 w-12 rounded-full border border-border bg-surface-muted"
            />
          )}

          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{profile.display_name}</p>
            <p className="truncate text-sm text-ink-subtle">@{profile.handle}</p>
          </div>
        </div>

        {profile.bio === null ? null : (
          <p className="text-sm text-ink-muted">{profile.bio}</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {profile.hashtags.map((tag) => (
            <Badge key={tag.slug} tone="neutral">
              #{tag.slug}
            </Badge>
          ))}
        </div>

        {/* Reputation lands in T06. Kept as a commented-out slot rather than a fake number so
            the card does not imply a scoring system that does not exist yet. */}
        <p className="text-xs text-ink-subtle">{REPUTATION_LABEL} arrives in a later release</p>
      </Stack>
    </Card>
  )
}