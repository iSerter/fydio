import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { Card, Stack } from '@fydio/ui'

import { PLATFORM_LABELS } from '@fydio/domain'

import { EntryCard, type EntryTag } from '@/components/entry/EntryCard'
import { coversBucket, publicStorageUrl } from '@/lib/env'
import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Back from the platform | Fydio',
}

/**
 * Return-to-Fydio (T08 §5.2): `/opened/[token]`.
 *
 * WHAT THIS PAGE IS. The end of the return leg. A member clicks "Open on
 * Instagram", reads or does not read the post, comes back to their Fydio tab, and
 * is offered the chance to leave feedback on what they just looked at.
 *
 * WHY A DEEP LINK RATHER THAN A MODIFIED OUTBOUND URL. The platform's URL is not
 * ours. Appending `?fydio_return=<token>` would put our identifier on somebody
 * else's page, in front of a member who was told Fydio never touches the original
 * link — and it would leak the token to every script on that page. So the token
 * never leaves Fydio: it is stored server-side, the outbound href is byte-for-byte
 * what the member submitted, and this page resolves the token on arrival. The cost
 * is that the member has to come back to their Fydio tab rather than being
 * redirected automatically, which is the honest trade: Fydio cannot follow someone
 * onto a platform page it does not control, and does not try.
 *
 * WHAT A FAILING TOKEN LOOKS LIKE. `validate_return_token` returns zero rows for
 * three indistinguishable reasons — unknown, someone else's, or older than thirty
 * minutes — and this page renders the same answer for all three. Naming which one
 * it was would turn a link into an oracle for guessing valid tokens, and the member
 * has nothing to act on either way: the remedy is the same, which is to open the
 * entry again.
 *
 * THE FEEDBACK PROMPT IS A PROMPT. The form itself is T09's; this page says the
 * entry is one they opened and links to it, rather than rendering a disabled
 * composer that looks broken.
 */
export default async function OpenedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // 64 hex characters, matching `encode(gen_random_bytes(32), 'hex')` in
  // `record_outbound_click`. Checked BEFORE the RPC: a token of the wrong shape is
  // certainly invalid, and rejecting it here avoids a pointless index probe with
  // attacker-controlled text — and keeps a junk `?token=` from reaching SQL at all.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return <ReturnFallback />
  }

  await requireUserId()

  const supabase = await memberClient()

  const { data: openedRows, error } = await supabase.rpc('validate_return_token', {
    p_token: token,
  })

  if (error !== null) {
    console.error('validate_return_token failed', error.message)

    return <ReturnFallback />
  }

  const [opened] = openedRows

  if (opened === undefined) {
    return <ReturnFallback />
  }

  const { entry_id: entryId } = opened

  const { data: entry } = await supabase
    .from('content_entries')
    .select(
      'id, author_id, platform, original_url, title, caption_excerpt, thumbnail_source, thumbnail_path, preview_state, creator_note, asks_for_feedback',
    )
    .eq('id', entryId)
    .maybeSingle()

  // The token was valid but the entry is gone — removed by its author between the
  // click and the return. `notFound` rather than the fallback: the link worked, and
  // the thing it pointed at does not exist, which is a different (and accurate)
  // answer from "your link expired".
  if (entry === null) notFound()

  const { data: tagRows } = await supabase
    .from('content_hashtags')
    .select('hashtag:hashtags(id, slug)')
    .eq('content_entry_id', entry.id)
    .order('position', { ascending: true })

  const tags: EntryTag[] = (tagRows ?? []).flatMap((row) => {
    const h = row.hashtag as unknown as { id?: string; slug?: string } | null
    return h?.id && h.slug ? [{ id: h.id, slug: h.slug }] : []
  })

  const { data: author } = await supabase
    .from('profiles')
    .select('display_name, handle')
    .eq('id', entry.author_id)
    .maybeSingle()

  const coverUrl =
    entry.thumbnail_path !== null
      ? publicStorageUrl(coversBucket(), entry.thumbnail_path)
      : null

  const platform = entry.platform

  // Acknowledge AFTER the render data is read, and ignore the result. This is the
  // bookkeeping for "the prompt has been shown"; the page's content does not depend
  // on it, so a failure here must not turn a valid return into an error page. The
  // function is idempotent, so a member who reloads does not double-stamp.
  await acknowledge(supabase, token)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Card title="Back from the platform">
        <Stack gap={3}>
          <p className="text-sm text-ink-muted">
            You opened this {PLATFORM_LABELS[platform]} from Fydio a moment ago. If
            you have a thought about it, this is the place for it.
          </p>

          {/* The prompt. Not a disabled composer: T09 builds the real form, and a
              greyed-out text box reads as a broken feature rather than a pending
              one. The link goes to the entry page, which is where the composer will
              live. */}
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={`/c/${entry.id}#leave-feedback`}
              className="inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Leave feedback
            </a>
            <a
              href={`/c/${entry.id}`}
              className="text-sm text-ink-muted hover:text-ink"
            >
              Back to the entry
            </a>
          </div>

          <p className="text-xs text-ink-subtle">
            Feedback is optional, and it never has to mention what you did on the
            platform — only what you think of the work.
          </p>
        </Stack>
      </Card>

      {author !== null ? (
        <p className="text-sm font-medium">
          {author.display_name} <span className="text-ink-subtle">@{author.handle}</span>
        </p>
      ) : null}

      <EntryCard
        entryId={entry.id}
        platform={platform}
        originalUrl={entry.original_url}
        title={entry.title}
        caption={entry.caption_excerpt}
        thumbnailSource={entry.thumbnail_source}
        coverUrl={coverUrl}
        previewState={entry.preview_state}
        hashtags={tags}
        creatorNote={entry.creator_note}
        asksForFeedback={entry.asks_for_feedback}
      />

      <p className="text-xs text-ink-subtle">
        This link works for 30 minutes and only for you. Fydio did not follow you to
        {` ${PLATFORM_LABELS[platform]}`} and does not know what you did
        there.
      </p>
    </main>
  )
}

/**
 * The expired-or-invalid answer.
 *
 * A page, not a redirect, and not `notFound()`. The member arrived here by clicking
 * around in their own history; sending them to a 404 tells them they made a mistake
 * when the only thing that happened is that half an hour passed. The link to their
 * feed is the useful next step.
 */
function ReturnFallback() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">This link has expired</h1>
      <p className="text-sm text-ink-muted">
        Return links work for 30 minutes, and only for the member who opened the post.
        Open the entry again from your feed and the link will be waiting.
      </p>
      <a
        href="/feed"
        className="inline-flex w-fit items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
      >
        Go to your feed
      </a>
    </main>
  )
}

/**
 * Stamp the return leg as taken.
 *
 * Errors are logged and dropped: the page above has already rendered the right
 * thing, and a bookkeeping failure is not the member's problem.
 */
async function acknowledge(
  supabase: Awaited<ReturnType<typeof memberClient>>,
  token: string,
): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_return_token', { p_token: token })

  if (error !== null) {
    console.error('acknowledge_return_token failed', error.message)
  }
}
