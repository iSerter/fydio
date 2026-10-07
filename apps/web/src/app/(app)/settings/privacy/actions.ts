'use server'

/**
 * Duration-consent actions (T08).
 *
 * Server Actions rather than API routes: these are called from a component inside
 * the app, not by a third party, and Next wraps them so the endpoint cannot be
 * invoked cross-origin.
 *
 * EVERY WRITE GOES THROUGH AN RPC. `grant_duration_consent` and
 * `revoke_duration_consent` take no user id — they read `auth.uid()` inside the
 * database — so there is no argument a caller could point at somebody else. That
 * is the property the whole consent model rests on, and it is why these actions
 * have nothing to authorise beyond "is this a member".
 */

import { revalidatePath } from 'next/cache'

import { memberClient, requireUserId } from '@/lib/server'

export interface ActionResult {
  readonly ok: boolean
  readonly message?: string
}

/**
 * Grant or revoke the caller's duration consent.
 *
 * Revocation is the interesting direction: the member is asking us to stop
 * collecting, so it must succeed even when they had not granted in the first
 * place. `revoke_duration_consent` returns `false` in that case rather than
 * raising, and this treats it as success — "you are off" is the state they asked
 * for, and an error would be a false claim that something went wrong.
 */
export async function setDurationConsent(granted: boolean): Promise<ActionResult> {
  await requireUserId()

  const supabase = await memberClient()

  const { error } = granted
    ? await supabase.rpc('grant_duration_consent', { p_source: 'settings' })
    : await supabase.rpc('revoke_duration_consent')

  if (error !== null) {
    // The RPC's own message is passed through rather than replaced: it is either
    // "Authentication required" or a named constraint, and both are more useful
    // than a generic failure.
    return { ok: false, message: error.message }
  }

  // The panel reads the consent row, so the cached render of this page is stale.
  revalidatePath('/settings/privacy')

  return { ok: true }
}

/**
 * Delete the caller's duration history.
 *
 * Separate from revocation on purpose: turning the feature off stops collection,
 * deleting the history removes what was already collected. Both are offered,
 * because a member who wants to stop being tracked and a member who wants the past
 * erased are different requests and conflating them serves neither.
 *
 * The confirmation lives in the component — this function does the work it is
 * asked to do, and re-checks the caller in the database like everything else.
 */
export async function deleteDurationHistory(): Promise<ActionResult> {
  await requireUserId()

  const supabase = await memberClient()

  const { data, error } = await supabase.rpc('delete_own_duration_history')

  if (error !== null) {
    return { ok: false, message: error.message }
  }

  revalidatePath('/settings/privacy')

  return {
    ok: true,
    message: `Deleted ${String(data)} duration record${data === 1 ? '' : 's'}.`,
  }
}
