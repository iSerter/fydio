import Image from 'next/image'

import { Card, Stack } from '@fydio/ui'

/**
 * A member's confirmed friends (T03).
 *
 * ONLY `state = 'accepted'` ROWS APPEAR HERE, and that is the whole point. Friend affinity in
 * the feed is "a transparent, limited boost for confirmed friends", so a pending request
 * cannot earn anything: showing one in a friends list would tell a member they have a friend
 * who has not agreed to it yet.
 *
 * The filter is applied in the DATABASE (`friend_connections` view / the route's `.eq`), not
 * by filtering in this component. A client-side filter would ship every pending and blocked
 * pair to the browser and rely on the UI to hide them -- which means the data was already
 * disclosed to anyone reading the response.
 */
export interface FriendListEntry {
  readonly userId: string
  readonly handle: string
  readonly display_name: string
  readonly avatar_path: string | null
}

export interface FriendListProps {
  readonly friends: readonly FriendListEntry[]
  readonly avatarBaseUrl?: string
}

export function FriendList({ friends, avatarBaseUrl }: FriendListProps) {
  return (
    <Card title="Friends">
      {friends.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No connections yet. Friend requests need both people to agree, so this list only fills
          up once someone accepts.
        </p>
      ) : (
        <Stack gap={2}>
          <ul className="flex flex-col gap-2">
            {friends.map((friend) => (
              <li key={friend.userId} className="flex items-center gap-3">
                {friend.avatar_path !== null && avatarBaseUrl !== undefined ? (
                  <Image
                    src={`${avatarBaseUrl}/${friend.avatar_path}`}
                    alt=""
                    width={32}
                    height={32}
                    unoptimized
                    className="h-8 w-8 rounded-full border border-border object-cover"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="h-8 w-8 rounded-full border border-border bg-surface-muted"
                  />
                )}

                <a href={`/u/${friend.handle}`} className="min-w-0 hover:underline">
                  <span className="block truncate text-sm font-medium text-ink">
                    {friend.display_name}
                  </span>
                  <span className="block truncate text-xs text-ink-subtle">@{friend.handle}</span>
                </a>
              </li>
            ))}
          </ul>
        </Stack>
      )}
    </Card>
  )
}