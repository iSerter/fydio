import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Badge, Card, Stack } from '@fydio/ui'
import { badgeForReputation, type ReputationSummary } from '@fydio/domain'

import { RatingStars } from '@/components/feedback/RatingStars'
import { ReportDialog } from '@/components/feedback/ReportDialog'
import { ReputationCard } from '@/components/reputation/ReputationCard'
import { ConnectionCard } from '@/components/social/ConnectionCard'
import { FriendList, type FriendListEntry } from '@/components/social/FriendList'
import type { FriendshipState } from '@/components/social/FriendRequestButton'
import { avatarBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Profile | Fydio',
}

export const dynamic = 'force-dynamic'

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const viewerId = await requireUserId()
  const { handle } = await params

  const supabase = await memberClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'id, handle, display_name, bio, avatar_path, role, reputation_total, rated_feedback_count, reputation_avg',
    )
    .eq('handle', handle)
    .maybeSingle()

  if (profile === null) {
    notFound()
  }

  const reputation: ReputationSummary = {
    kind: 'reputation',
    total: profile.reputation_total,
    ratedCount: profile.rated_feedback_count,
    average:
      typeof profile.reputation_avg === 'string'
        ? Number(profile.reputation_avg)
        : profile.reputation_avg,
    badge: badgeForReputation(profile.reputation_total),
  }

  const { data: tags } = await supabase
    .from('profile_hashtags')
    .select('hashtag:hashtags(slug, label)')
    .eq('profile_id', profile.id)
    .order('position', { ascending: true })

  const { data: links } = await supabase
    .from('profile_links')
    .select('platform, url')
    .eq('profile_id', profile.id)

  const { data: friendRows } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id')
    .eq('state', 'accepted')
    .or(`requester_id.eq.${profile.id},addressee_id.eq.${profile.id}`)

  const friendIds = (friendRows ?? [])
    .map((row) => (row.requester_id === profile.id ? row.addressee_id : row.requester_id))
    .filter((id): id is string => typeof id === 'string')

  const { data: friendProfiles } =
    friendIds.length === 0
      ? { data: [] }
      : await supabase
          .from('profiles')
          .select('id, handle, display_name, avatar_path')
          .in('id', friendIds)
          .order('handle', { ascending: true })

  const friends: FriendListEntry[] = (friendProfiles ?? []).map((row) => ({
    userId: row.id,
    handle: row.handle,
    display_name: row.display_name,
    avatar_path: row.avatar_path,
  }))

  const isSelf = profile.id === viewerId

  const { data: pairRow } = isSelf
    ? { data: null }
    : await supabase
        .from('friendships')
        .select('id, state, requester_id')
        .or(`requester_id.eq.${profile.id},addressee_id.eq.${profile.id}`)
        .in('requester_id', [profile.id, viewerId])
        .in('addressee_id', [profile.id, viewerId])
        .maybeSingle()

  const friendship: FriendshipState = pairRow?.state ?? 'none'
  const viewerRequested = pairRow?.requester_id === viewerId

  const avatarUrl = publicStorageUrl(avatarBucket(), profile.avatar_path)

  // 1. Shared entries
  const { data: sharedEntries } = await supabase
    .from('content_entries')
    .select('id, title, platform, published_at')
    .eq('author_id', profile.id)
    .eq('status', 'active')
    .order('published_at', { ascending: false })
    .limit(5)

  // 2. Rated feedback authored by this member
  const { data: ratedFeedbackRows } = await supabase
    .from('feedback')
    .select(`
      id, entry_id, body, created_at,
      entry:content_entries(id, title, platform),
      ratings:feedback_ratings!inner(score)
    `)
    .eq('author_id', profile.id)
    .is('removed_at', null)
    .order('created_at', { ascending: false })
    .limit(5)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Card>
        <Stack gap={4}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              {avatarUrl === null ? (
                <div
                  aria-hidden="true"
                  className="h-20 w-20 rounded-full border border-border bg-surface-muted"
                />
              ) : (
                <Image
                  src={avatarUrl}
                  alt=""
                  width={80}
                  height={80}
                  unoptimized
                  className="h-20 w-20 rounded-full border border-border object-cover"
                />
              )}

              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {profile.display_name}
                </h1>
                <p className="truncate text-sm text-ink-subtle">@{profile.handle}</p>
                {profile.role === 'admin' ? (
                  <Badge tone="brand" className="mt-1">
                    admin
                  </Badge>
                ) : null}
              </div>
            </div>

            {!isSelf && (
              <ReportDialog
                targetType="user"
                targetId={profile.id}
                targetLabel={`@${profile.handle}`}
                triggerLabel="Report profile"
              />
            )}
          </div>

          {profile.bio === null ? null : <p className="text-ink-muted">{profile.bio}</p>}

          <div className="flex flex-wrap gap-1.5">
            {(tags ?? []).map((row, index) => (
              <Badge key={index} tone="neutral">
                {slugLabel(row.hashtag)}
              </Badge>
            ))}
          </div>

          <ReputationCard reputation={reputation} />
        </Stack>
      </Card>

      {(links ?? []).length === 0 ? null : (
        <Card title="Elsewhere">
          <ul className="flex flex-col gap-1 text-sm">
            {(links ?? []).map((link) => (
              <li key={link.platform}>
                <span className="text-ink-muted">{link.platform}: </span>
                <a
                  href={link.url}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="text-brand hover:underline"
                >
                  {link.url}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isSelf ? (
        <Card title="This is you">
          <Stack gap={3}>
            <p className="text-sm text-ink-muted">
              Manage your display name, bio, hashtags, and view your private feedback portfolio.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/settings/profile"
                className="inline-flex w-fit items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
              >
                Edit profile
              </Link>
              <Link
                href="/dashboard/feedback"
                className="inline-flex w-fit items-center justify-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Feedback Portfolio
              </Link>
            </div>
          </Stack>
        </Card>
      ) : null}

      {!isSelf && (
        <ConnectionCard
          viewerId={viewerId}
          otherId={profile.id}
          state={friendship}
          viewerRequested={viewerRequested}
          friendshipId={pairRow?.id ?? null}
        />
      )}

      <FriendList friends={friends} />

      {/* Shared entries */}
      <Card title="Things shared">
        {(sharedEntries ?? []).length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing shared yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(sharedEntries ?? []).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between py-1 border-b border-border last:border-0">
                <Link href={`/c/${entry.id}`} className="text-sm font-medium text-ink hover:text-brand transition line-clamp-1">
                  {entry.title ?? `Entry ${entry.id.slice(0, 8)}`}
                </Link>
                <span className="text-xs text-ink-subtle uppercase">{entry.platform}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Public rated feedback */}
      <Card title="Rated Feedback Highlights">
        {(ratedFeedbackRows ?? []).length === 0 ? (
          <p className="text-sm text-ink-muted">No rated feedback highlights yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {(ratedFeedbackRows ?? []).map((item) => {
              const entry = item.entry as unknown as { id: string; title: string | null; platform: string } | null
              const ratingsRaw = item.ratings as unknown as { score: number }[] | { score: number } | null
              const r = Array.isArray(ratingsRaw) ? ratingsRaw[0] : ratingsRaw
              return (
                <li key={item.id} className="rounded-control border border-border bg-surface-muted p-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <Link href={`/c/${item.entry_id}`} className="font-semibold text-ink hover:text-brand line-clamp-1">
                      On: {entry?.title ?? `Entry ${item.entry_id.slice(0, 8)}`}
                    </Link>
                    {typeof r?.score === 'number' && (
                      <div className="flex items-center gap-1 font-semibold text-ink">
                        <RatingStars score={r.score} />
                        <span>{r.score}/10</span>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-ink line-clamp-2">{item.body}</p>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </main>
  )
}

function slugLabel(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''

  const slug = (value as { slug?: unknown }).slug

  return typeof slug === 'string' ? `#${slug}` : ''
}
