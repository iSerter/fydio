'use server'

import { revalidatePath } from 'next/cache'

import type { PlatformKind } from '@fydio/supabase'
import {
  MAX_PROFILE_HASHTAGS,
  bioSchema,
  displayNameSchema,
  onboardingSchema,
  profileEditSchema,
} from '@fydio/domain'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Profile and onboarding writes (T03).
 *
 * These are Server Actions rather than API routes because they are called from forms inside
 * the app, not from third parties: Next wraps them so the endpoint cannot be invoked with a
 * hand-rolled request from another origin, which is one less thing to get right than a
 * `POST /api/profile` would be.
 *
 * VALIDATION RUNS TWICE, ON PURPOSE. `@fydio/domain` validates first, so a member gets a
 * specific field message instead of a constraint violation. The database then validates
 * again -- the five-hashtag cap is a deferred constraint trigger there -- and that second
 * check is the one that counts. Neither layer is optional: the client one is for the member,
 * the database one is for every other caller.
 *
 * Returns a discriminated result rather than throwing. A thrown error in a Server Action
 * surfaces as an opaque digest in the browser, which is useless for telling someone their
 * sixth hashtag was refused.
 */

export interface ActionResult {
  readonly ok: boolean
  readonly message?: string
  /** Field-level messages, keyed by form field. */
  readonly fieldErrors?: Record<string, string>
}

/** Flatten zod issues into `{ field: message }`, keeping the first per field. */
function fieldErrorsOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  const result: Record<string, string> = {}

  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form'
    if (!(key in result)) result[key] = issue.message
  }

  return result
}

/**
 * Save one onboarding step.
 *
 * Steps are saved independently so a member can leave and come back: the wizard's whole
 * purpose is a five-step flow, and losing step 2 to a refresh would be the single most
 * likely way a new member abandons onboarding.
 *
 * `onboarding_completed_at` is set ONLY by `completeOnboarding`, never here. That column is
 * the proxy's gate, so a partial save must not open the rest of the app.
 */
export async function saveOnboardingStep(input: {
  displayName?: string
  bio?: string
}): Promise<ActionResult> {
  const userId = await requireUserId()

  const patch: { display_name?: string; bio?: string | null } = {}

  if (input.displayName !== undefined) {
    const parsed = displayNameSchema.safeParse(input.displayName)

    if (!parsed.success) {
      return { ok: false, message: 'Check your display name.', fieldErrors: fieldErrorsOf(parsed.error) }
    }

    patch.display_name = parsed.data
  }

  if (input.bio !== undefined) {
    const parsed = bioSchema.safeParse(input.bio)

    if (!parsed.success) {
      return { ok: false, message: 'Check your bio.', fieldErrors: fieldErrorsOf(parsed.error) }
    }

    patch.bio = parsed.data ?? null
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true }
  }

  const supabase = await memberClient()
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId)

  if (error) {
    return { ok: false, message: 'Could not save that. Please try again.' }
  }

  return { ok: true }
}

/**
 * Save the chosen hashtags.
 *
 * Routed through `set_profile_hashtags` rather than a direct INSERT/DELETE pair, because the
 * RPC deletes and re-inserts in ONE transaction. Doing it as separate statements would leave
 * a window in which the profile has fewer than five tags, and the T07 feed would read that
 * window as a member matching on four signals instead of five.
 */
export async function setHashtags(hashtagIds: readonly string[]): Promise<ActionResult> {
  await requireUserId()

  if (hashtagIds.length > MAX_PROFILE_HASHTAGS) {
    return {
      ok: false,
      message: `A profile may have at most ${MAX_PROFILE_HASHTAGS} hashtags.`,
    }
  }

  const supabase = await memberClient()
  const { error } = await supabase.rpc('set_profile_hashtags', {
    p_hashtags: [...hashtagIds],
  })

  if (error) {
    // Passed through rather than replaced: `set_profile_hashtags` raises with a message about
    // the five-tag limit, which is exactly what the member needs to read.
    return { ok: false, message: error.message }
  }

  return { ok: true }
}

/**
 * Finish onboarding.
 *
 * The one place `onboarding_completed_at` is set, because it is the proxy's gate and a
 * partial save must not open the rest of the app.
 *
 * The hashtag count is re-checked here even though `setHashtags` already enforced it, because
 * this is the moment the claim "I have chosen five hashtags" becomes true and it should be
 * true in one place. Reading the count back from the table rather than trusting the submitted
 * array means a client that lied is caught.
 */
export async function completeOnboarding(input: {
  displayName: string
  bio?: string
  hashtags: readonly string[]
}): Promise<ActionResult> {
  const userId = await requireUserId()

  const parsed = onboardingSchema.safeParse({
    displayName: input.displayName,
    bio: input.bio ?? '',
    hashtags: input.hashtags,
    links: [],
  })

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Some details still need attention.',
      fieldErrors: fieldErrorsOf(parsed.error),
    }
  }

  const supabase = await memberClient()

  const { error: hashtagError } = await supabase.rpc('set_profile_hashtags', {
    p_hashtags: [...parsed.data.hashtags],
  })

  if (hashtagError) {
    return { ok: false, message: hashtagError.message }
  }

  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      display_name: parsed.data.displayName,
      bio: parsed.data.bio ?? null,
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (profileError) {
    return { ok: false, message: 'Could not finish setting up your profile.' }
  }

  revalidatePath('/', 'layout')

  return { ok: true }
}

/** Replace the editable parts of a profile. Does NOT touch onboarding or reputation. */
export async function updateProfile(input: {
  displayName: string
  bio?: string
}): Promise<ActionResult> {
  const userId = await requireUserId()

  const parsed = profileEditSchema
    .pick({ displayName: true, bio: true })
    .safeParse({ displayName: input.displayName, bio: input.bio ?? '' })

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Check those details.',
      fieldErrors: fieldErrorsOf(parsed.error),
    }
  }

  const supabase = await memberClient()
  const { error } = await supabase
    .from('profiles')
    .update({ display_name: parsed.data.displayName, bio: parsed.data.bio ?? null })
    .eq('id', userId)

  if (error) {
    return { ok: false, message: 'Could not save your profile.' }
  }

  revalidatePath('/settings/profile')

  // The public profile page renders the display name and bio. Revalidated by LAYOUT rather
  // than by a path: the route is `/u/[handle]`, and this action does not know the handle --
  // the member may not have changed it, and re-reading it here would be a second query for a
  // value that only matters on the rare occasion it changed.
  revalidatePath('/', 'layout')

  return { ok: true }
}

/** Replace the optional public platform links. One per platform, by database constraint. */
export async function saveProfileLinks(
  links: readonly { platform: string; url: string; label?: string }[],
): Promise<ActionResult> {
  const userId = await requireUserId()

  const supabase = await memberClient()

  // Replace wholesale rather than diffing. There are at most four links, the table has no
  // other writers, and a diff is three queries plus a delete that could half-apply.
  const { error: deleteError } = await supabase
    .from('profile_links')
    .delete()
    .eq('profile_id', userId)

  if (deleteError) {
    return { ok: false, message: 'Could not save your links. Please try again.' }
  }

  if (links.length === 0) return { ok: true }

  // `platform` is narrowed to the `platform_kind` union here rather than being passed
  // through as `string`. The generated row type demands the literal union, and letting a
  // bare string reach `insert` would mean the database -- not the compiler -- is what
  // rejects a typo'd platform name.
  const rows = links.map((link) => ({
    profile_id: userId,
    platform: link.platform as PlatformKind,
    url: link.url,
    label: link.label ?? null,
  }))

  const { error: insertError } = await supabase.from('profile_links').insert(rows)

  if (insertError) {
    return { ok: false, message: insertError.message }
  }

  revalidatePath('/settings/profile')

  return { ok: true }
}