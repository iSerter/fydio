'use client'

import { useRouter } from 'next/navigation'

import { Card, Stack } from '@fydio/ui'

import { FriendRequestButton, type FriendshipState } from './FriendRequestButton'

/**
 * The connection control on someone's profile, plus the refresh that keeps it honest.
 *
 * WHY A WRAPPER EXISTS. The pair state is read by the server component that renders the profile,
 * because the state machine lives in SQL. Changing it therefore has to come back from the
 * server -- but `useRouter` is a Client Component hook, so a server component cannot reach it.
 * This wrapper is that seam, and nothing more.
 *
 * WHY `router.refresh()` RATHER THAN LOCAL STATE. The alternative is to update the button's
 * state in place and skip the round trip, which is faster but lets the view disagree with the
 * database whenever the two differ -- a declined request the server rejected, or a friendship
 * the server refused to create because a block was already in place. The member would see a
 * friendship that does not exist. A refresh cannot lie: the next render is whatever SQL says.
 */
export interface ConnectionCardProps {
  readonly viewerId: string
  readonly otherId: string
  readonly state: FriendshipState
  readonly viewerRequested: boolean
  readonly friendshipId: string | null
}

export function ConnectionCard(props: ConnectionCardProps) {
  const router = useRouter()

  return (
    <Card title="Connection">
      <Stack gap={3}>
        <FriendRequestButton {...props} onChanged={() => { router.refresh() }} />
      </Stack>
    </Card>
  )
}
