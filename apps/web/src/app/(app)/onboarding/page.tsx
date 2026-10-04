import type { Metadata } from 'next'

import { Badge, Stack } from '@fydio/ui'

import { avatarBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'
import { OnboardingWizard, type OnboardingLink } from './OnboardingWizard'

export const metadata: Metadata = {
  title: 'Set up your profile | Fydio',
}

/**
 * Dynamic: renders the member's current draft.
 *
 * Prerendering this would bake in one member's saved state into a static file served to
 * everyone -- so it must render per request.
 */
export const dynamic = 'force-dynamic'

/**
 * The onboarding page (T03).
 *
 * Reached only from the proxy's onboarding gate, which redirects here when
 * `onboarding_completed_at IS NULL`. The page does not re-check that itself: the proxy runs
 * before every render, so a second check would be a second rule to keep in step with the
 * first. What it DOES do is refuse an anonymous visitor, because the proxy's allowlist does not
 * include this path and the queries below would return nothing anyway.
 */
export default async function OnboardingPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, bio, avatar_path')
    .eq('id', userId)
    .maybeSingle()

  // The member's chosen hashtags, joined to the shared vocabulary so the picker can render
  // slugs and labels rather than bare ids.
  const { data: tags } = await supabase
    .from('profile_hashtags')
    .select('position, hashtag:hashtags(id, slug, label, usage_count, is_official)')
    .eq('profile_id', userId)
    .order('position', { ascending: true })

  const { data: links } = await supabase
    .from('profile_links')
    .select('platform, url')
    .eq('profile_id', userId)

  const initialHashtags = (tags ?? [])
    .map((row) => row.hashtag)
    .filter(isHashtagRow)
    .sort((a, b) => positionOf(tags ?? [], a.id) - positionOf(tags ?? [], b.id))

  const initialLinks: OnboardingLink[] = (links ?? [])
    .map((row) => ({ platform: row.platform, url: row.url }))
    .filter(isPlatformRow)

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">Almost there</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Set up your profile</h1>
        <p className="text-ink-muted">
          Five short steps. The hashtags matter most — they are what decides what appears in
          your feed.
        </p>
      </Stack>

      <OnboardingWizard
        initialDisplayName={profile?.display_name ?? ''}
        initialBio={profile?.bio ?? ''}
        initialAvatarUrl={publicStorageUrl(avatarBucket(), profile?.avatar_path ?? null)}
        initialHashtags={initialHashtags}
        initialLinks={initialLinks}
      />
    </main>
  )
}

interface HashtagRow {
  readonly id: string
  readonly slug: string
  readonly label: string
  readonly usage_count: number
  readonly is_official: boolean
}

/**
 * Narrow the joined `hashtag` object.
 *
 * PostgREST returns a related row as either an object or an ARRAY of one when it cannot tell
 * the cardinality from the schema -- which it cannot here, because the join is inferred from
 * the foreign key rather than declared. Accepting only the object shape means a change in how
 * the join resolves shows up as zero tags on this screen instead of a crash.
 */
function isHashtagRow(value: unknown): value is HashtagRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const row = value as Partial<HashtagRow>

  return (
    typeof row.id === 'string' &&
    typeof row.slug === 'string' &&
    typeof row.label === 'string' &&
    typeof row.usage_count === 'number' &&
    typeof row.is_official === 'boolean'
  )
}

function positionOf(
  rows: readonly { position: number; hashtag: unknown }[],
  hashtagId: string,
): number {
  const found = rows.find((row) => {
    if (typeof row.hashtag !== 'object' || row.hashtag === null) return false
    return (row.hashtag as { id?: unknown }).id === hashtagId
  })

  return found?.position ?? 0
}

function isPlatformRow(value: { platform: string; url: string }): value is OnboardingLink {
  return ['instagram', 'tiktok', 'youtube', 'x'].includes(value.platform)
}