import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'

import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Feed | Fydio',
}

/**
 * Dynamic: per-member.
 *
 * It reads the member's profile so the redirect target exists and can show something useful
 * even before T07 replaces it. Making this page exist is not scope creep -- the proxy already
 * redirects here after sign-in and after onboarding, so without it both paths would 404 and
 * the whole invite-to-profile journey would end in an error.
 */
export const dynamic = 'force-dynamic'

/**
 * The feed placeholder (T07 owns the real one).
 *
 * Deliberately empty of content, with an honest explanation. A page that says "nothing here
 * yet" when the feed already exists would be worse than one that says the feed is not built.
 *
 * It DOES render the member's hashtags, because those are the ranking signal T07 will consume,
 * and seeing them here makes the connection between onboarding and the feed legible.
 */
export default async function FeedPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, handle')
    .eq('id', userId)
    .maybeSingle()

  const { data: tags } = await supabase
    .from('profile_hashtags')
    .select('hashtag:hashtags(slug)')
    .eq('profile_id', userId)
    .order('position', { ascending: true })

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">T03 · complete</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {profile?.display_name ?? 'friend'}
        </h1>

        {/* The handle was already fetched for the ranking signals below; without this link it is
            selected and never used, and a new member has no way to reach their own profile
            without guessing a URL. */}
        {profile === null ? null : (
          <a
            href={`/u/${profile.handle}`}
            className="inline-flex w-fit items-center gap-1 text-sm text-brand hover:underline"
          >
            View your public profile (@{profile.handle})
          </a>
        )}
      </Stack>

      <Card title="Your ranking signals">
        <Stack gap={3}>
          <p className="text-sm text-ink-muted">
            Your five hashtags are what the feed will match on. These are the ones currently
            attached to your profile:
          </p>

          <div className="flex flex-wrap gap-1.5">
            {(tags ?? []).map((row, index) => (
              <span
                key={index}
                className="rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs text-ink"
              >
                {slugOf(row.hashtag)}
              </span>
            ))}
          </div>
        </Stack>
      </Card>

      <Card title="The feed is not built yet">
        <p className="text-sm text-ink-muted">
          Ranking, transparency and freshness arrive in the next release. Everything you need
          for it is in place: your profile carries exactly five hashtags, and confirmed friends
          are recorded as mutual connections.
        </p>
      </Card>
    </main>
  )
}

function slugOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''

  const slug = (value as { slug?: unknown }).slug

  return typeof slug === 'string' ? `#${slug}` : ''
}