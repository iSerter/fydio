import Image from 'next/image'

import { Badge, Card, Stack } from '@fydio/ui'

import { badgeForReputation, formatReputationAverage, formatReputationTotal } from '@fydio/domain'

/**
 * A member summary (T03) with public reputation (T06).
 *
 * A Server Component: a profile card appears many times per feed page and needs no state, so
 * making it a Client Component would ship its props and hydration cost to every reader for no
 * benefit.
 *
 * Reputation is public by product decision — total, count, average and badge come from the
 * `get_reputation` shape via `profiles` aggregates. Credits never appear here; they are private
 * and spendable, and this card answers "how useful", not "what can I spend".
 */
export interface ProfileCardData {
  readonly handle: string
  readonly display_name: string
  readonly bio: string | null
  readonly avatar_path: string | null
  readonly hashtags: readonly { slug: string; label: string }[]
  readonly reputation_total?: number
  readonly rated_feedback_count?: number
  readonly reputation_avg?: number | string | null
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

        {profile.bio === null ? null : <p className="text-sm text-ink-muted">{profile.bio}</p>}

        <div className="flex flex-wrap gap-1.5">
          {profile.hashtags.map((tag) => (
            <Badge key={tag.slug} tone="neutral">
              #{tag.slug}
            </Badge>
          ))}
        </div>

        {/* Reputation (T06): public helpfulness signal, same numbers as the profile page. */}
        <p className="text-xs text-ink-subtle">
          {formatReputationTotal(profile.reputation_total ?? 0)}
          {' · '}
          {formatReputationAverage(
            typeof profile.reputation_avg === 'string'
              ? Number(profile.reputation_avg)
              : (profile.reputation_avg ?? null),
            profile.rated_feedback_count ?? 0,
          )}
          {' · '}
          {badgeForReputation(profile.reputation_total ?? 0)}
        </p>
      </Stack>
    </Card>
  )
}
