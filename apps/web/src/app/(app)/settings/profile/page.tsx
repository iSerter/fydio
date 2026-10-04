import type { Metadata } from 'next'

import { Badge, Stack } from '@fydio/ui'

import { ProfileEditor } from '@/components/profile/ProfileEditor'
import type { HashtagOption } from '@/components/profile/HashtagPicker'
import type { PlatformLinkValue } from '@/components/profile/PlatformLinksEditor'
import { avatarBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Your profile | Fydio',
}

/** Dynamic: reads the signed-in member's own row. */
export const dynamic = 'force-dynamic'

/**
 * The profile editor (T03 §7).
 *
 * A page, not a second editor: the form itself is `ProfileEditor`, which composes the same
 * `AvatarUploader`, `BioField`, `HashtagPicker` and `PlatformLinksEditor` the onboarding wizard
 * uses. That reuse is the requirement -- these components are where the five-hashtag cap, the
 * name and bio limits and the per-platform URL rules actually live, so a page with its own
 * inputs would be a second implementation of rules that must not diverge.
 *
 * This server component's whole job is to load current values and turn the joined rows into the
 * option shapes those components expect.
 */
export default async function ProfileSettingsPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, bio, avatar_path')
    .eq('id', userId)
    .maybeSingle()

  const { data: tagRows } = await supabase
    .from('profile_hashtags')
    .select('hashtag:hashtags(id, slug, label, usage_count, is_official)')
    .eq('profile_id', userId)
    .order('position', { ascending: true })

  const { data: linkRows } = await supabase
    .from('profile_links')
    .select('platform, url')
    .eq('profile_id', userId)

  // Flat, with no null-guard: the generated relation type is non-nullable, because
  // `profile_hashtags` has an inner join to `hashtags` and a foreign key, so a row can only
  // exist while its tag does. ESLint is right that a guard here is unreachable code.
  const hashtags: HashtagOption[] = (tagRows ?? []).map((row) => ({
    id: row.hashtag.id,
    slug: row.hashtag.slug,
    label: row.hashtag.label,
    usage_count: row.hashtag.usage_count,
    is_official: row.hashtag.is_official,
  }))

  // No runtime narrowing here, and deliberately so. `profile_links.platform` is an enum in the
  // schema, so the generated row type already gives `row.platform` the `platform_kind` union --
  // the compiler enforces the constraint the column does. A hand-written guard would be a
  // second encoding of a rule that is already in the types, and ESLint correctly flags it as
  // unreachable.
  const links: PlatformLinkValue[] = (linkRows ?? []).map((row) => ({
    platform: row.platform,
    url: row.url,
  }))

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">Settings</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
        <p className="text-ink-muted">
          Your display name, photo, bio and hashtags are visible to everyone in the community.
        </p>
      </Stack>

      <ProfileEditor
        initialDisplayName={profile?.display_name ?? ''}
        initialBio={profile?.bio ?? ''}
        initialAvatarUrl={publicStorageUrl(avatarBucket(), profile?.avatar_path ?? null)}
        initialHashtags={hashtags}
        initialLinks={links}
      />
    </main>
  )
}
