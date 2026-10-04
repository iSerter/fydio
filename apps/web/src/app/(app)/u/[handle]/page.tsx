import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'

import { Badge, Card, Stack } from '@fydio/ui'

import { FriendList, type FriendListEntry } from '@/components/social/FriendList'
import { ConnectionCard } from '@/components/social/ConnectionCard'
import type { FriendshipState } from '@/components/social/FriendRequestButton'
import { avatarBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Profile | Fydio',
}

/**
 * Dynamic, and `force-dynamic` on purpose.
 *
 * Every member's profile is a distinct path, so this cannot be prerendered as a set. More
 * importantly it must not be cached at all: a cached page would keep serving a display name or
 * bio after it changed.
 */
export const dynamic = 'force-dynamic'

/**
 * A member's public profile (T03).
 *
 * REACHABLE BY ANY SIGNED-IN MEMBER, NOT BY ANONYMOUS VISITORS. "Public" in a private,
 * invite-only community means "visible to other members" -- the brief's own framing, and the
 * reason the proxy does not list `/u` in its allowlist. RLS agrees: `profiles_read` is scoped
 * `to authenticated`, so an anon request would return nothing even if the proxy were bypassed.
 *
 * Handles are `citext` with a unique index, so the lookup is case-insensitive by construction --
 * `/u/AdaLovelace` and `/u/adalovelace` are the same member and neither 404s.
 */
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
      'id, handle, display_name, bio, avatar_path, role, reputation_total, rated_feedback_count',
    )
    .eq('handle', handle)
    .maybeSingle()

  if (profile === null) {
    notFound()
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

  // `accepted` only. A pending request is not a friendship, and listing one would tell the
  // viewer they have a friend who has not agreed to it.
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

  // The pair's CURRENT state, read server-side for the same reason the friends list filters to
  // `accepted`: the state machine lives in SQL, and the button must render what is true rather
  // than what the viewer might want. Filtering by state here would make a pending request
  // invisible and permanently offer "Add friend" to someone who already asked -- which would
  // then fail server-side, having told the member they did something wrong.
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

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Card>
        <Stack gap={4}>
          <div className="flex items-center gap-4">
            {avatarUrl === null ? (
              <div
                aria-hidden="true"
                className="h-20 w-20 rounded-full border border-border bg-surface-muted"
              />
            ) : (
              // `next/image` with `unoptimized`: the source is a public Storage object already
              // stored as a 512px WebP under 200 KB, so the optimiser has nothing to add.
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

          {profile.bio === null ? null : <p className="text-ink-muted">{profile.bio}</p>}

          <div className="flex flex-wrap gap-1.5">
            {(tags ?? []).map((row, index) => (
              <Badge key={index} tone="neutral">
                {slugLabel(row.hashtag)}
              </Badge>
            ))}
          </div>

          <p className="text-xs text-ink-subtle">
            {profile.rated_feedback_count === 0
              ? 'No ratings yet'
              : `${profile.reputation_total} reputation from ${profile.rated_feedback_count} ratings`}
          </p>
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
              Edit your display name, photo, bio and hashtags from your profile settings.
            </p>
            <a
              href="/settings/profile"
              className="inline-flex w-fit items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Edit profile
            </a>
          </Stack>
        </Card>
      ) : null}

      {isSelf ? null : (
        <ConnectionCard
          viewerId={viewerId}
          otherId={profile.id}
          state={friendship}
          viewerRequested={viewerRequested}
          friendshipId={pairRow?.id ?? null}
        />
      )}

      <FriendList friends={friends} />

      {/* Entries, feedback and reputation land in T04/T06/T09. The placeholder says so rather
          than rendering an empty section with no explanation. */}
      <Card title="Things shared">
        <p className="text-sm text-ink-muted">
          Nothing shared yet. Sharing and feedback arrive in a later release.
        </p>
      </Card>
    </main>
  )
}

function slugLabel(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''

  const slug = (value as { slug?: unknown }).slug

  return typeof slug === 'string' ? `#${slug}` : ''
}