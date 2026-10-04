'use client'

import { useState } from 'react'

import { Button, Stack } from '@fydio/ui'

/**
 * The connection control on a profile (T03).
 *
 * Which button to show is decided by the pair's CURRENT state, not by what the viewer wants to
 * do -- and the state comes from the server, because the state machine is enforced there. A
 * client that guessed would eventually offer "Accept" to the person who sent the request,
 * which is the exact mistake the `respond_friend_request` addressee check exists to prevent.
 */
export type FriendshipState = 'none' | 'pending' | 'accepted' | 'declined' | 'blocked'

export interface FriendRequestButtonProps {
  readonly viewerId: string
  readonly otherId: string
  readonly state: FriendshipState
  /** True when the viewer sent the pending request, rather than receiving it. */
  readonly viewerRequested: boolean
  /**
   * The friendship row's id.
   *
   * Required for accept/decline/remove, which address a specific request rather than a
   * member. It is NOT derivable on the client: `pair_key` is a server-side convention, and
   * inventing a matching hash here would be a second, divergent implementation of the rule
   * that makes a pair canonical.
   */
  readonly friendshipId: string | null
  readonly onChanged: (next: FriendshipState) => void
}

export function FriendRequestButton({
  viewerId,
  otherId,
  state,
  viewerRequested,
  friendshipId,
  onChanged,
}: FriendRequestButtonProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Blocking hides you from someone; they need no way to confirm it happened.
  if (state === 'blocked' || otherId === viewerId) return null

  async function act(action: 'send' | 'accept' | 'decline' | 'remove') {
    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/friendships', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          addresseeId: action === 'send' ? otherId : undefined,
          friendshipId: friendshipId,
          userId: otherId,
        }),
      })

      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        setError(readError(payload) ?? 'That did not work.')
        return
      }

      // Spelled out rather than derived from `action`, because `accept` and `decline` are the
      // two cases a shortcut gets wrong: collapsing both into one branch would report a
      // successful accept as "declined", which renders back as "Send request again" -- telling
      // the member the friendship they just made does not exist.
      if (action === 'send') onChanged('pending')
      else if (action === 'accept') onChanged('accepted')
      else if (action === 'decline') onChanged('declined')
      else onChanged('none')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap={2}>
      {state === 'none' || state === 'declined' ? (
        <Button onClick={() => void act('send')} disabled={busy}>
          {busy ? 'Sending…' : state === 'declined' ? 'Send request again' : 'Add friend'}
        </Button>
      ) : null}

      {state === 'pending' && viewerRequested ? (
        <p className="text-sm text-ink-muted">Request sent — waiting for a reply.</p>
      ) : null}

      {state === 'pending' && !viewerRequested ? (
        <Stack gap={2} direction="row">
          <Button onClick={() => void act('accept')} disabled={busy}>
            {busy ? 'Working…' : 'Accept request'}
          </Button>
          <Button variant="ghost" onClick={() => void act('decline')} disabled={busy}>
            Decline
          </Button>
        </Stack>
      ) : null}

      {state === 'accepted' ? (
        <Button variant="secondary" onClick={() => void act('remove')} disabled={busy}>
          {busy ? 'Working…' : 'Remove friend'}
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </Stack>
  )
}

function readError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null

  const error = (payload as { error?: unknown }).error

  return typeof error === 'string' ? error : null
}