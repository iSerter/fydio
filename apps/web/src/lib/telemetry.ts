'use client'

import { createBrowserClient } from '@fydio/supabase/browser'

/**
 * Outbound-click recording from the browser (T08).
 *
 * This module is CLIENT-SAFE and deliberately has no `server-only` marker: the
 * outbound link is an `<a>` in a feed card, and the click has to be recorded from
 * the same context that fires the click. A server-only helper here would make the
 * link a form submission, which is exactly the "navigation blocked on a network
 * call" behaviour the button must not have.
 *
 * THE CONTRACT WITH `OpenOriginalButton`: fire-and-forget, never awaited, never
 * allowed to reject into the caller. A member clicking "Open on Instagram" must
 * reach Instagram regardless of what Fydio's analytics is doing, so every failure
 * mode here resolves to `null` and the caller proceeds.
 */

/** Where a click came from. Lets the activity list group by surface. */
export type ClickSource = 'feed' | 'entry_page' | 'profile'

/** What `record_outbound_click` returns, narrowed to what the caller needs. */
export interface OutboundClickResult {
  readonly clickId: string
  readonly returnToken: string
}

/**
 * Record that this member activated an entry's outbound link.
 *
 * The RPC (`record_outbound_click`) does three things in one transaction: writes
 * the click, marks `feed_impressions.opened` for THIS member, and mints the return
 * token. The browser client is used rather than a route so there is no extra hop
 * between the click and the record — and so the call carries the member's own
 * session, which is what makes the `opened` mark provably theirs.
 *
 * `opened` means "activated the link", NOT "read the post". Nothing downstream may
 * treat it as a view: it is a personal feed-history signal, and the whole privacy
 * story in T08 rests on it never becoming engagement.
 */
export async function recordOutboundClick(
  entryId: string,
  source: ClickSource,
): Promise<OutboundClickResult | null> {
  try {
    const supabase = createBrowserClient()

    const { data, error } = await supabase.rpc('record_outbound_click', {
      p_entry_id: entryId,
      p_client: 'web',
      p_source: source,
    })

    if (error !== null) {
      // Swallowed on purpose. The member is on their way to another site; a failed
      // analytics write is not something they can act on, and surfacing it would
      // mean blocking or interrupting navigation for a non-event.
      console.error('recordOutboundClick failed', error.message)

      return null
    }

    const row = firstRow(data)

    // A `null` here means the RPC returned successfully with no row, which should
    // not happen. Treated the same as an error: the click still opened.
    if (row === null) return null

    return row
  } catch (error) {
    console.error('recordOutboundClick threw', error)

    return null
  }
}

/**
 * The RPC now returns a `SETOF` composite, so PostgREST hands back an array of
 * rows rather than a bare object.
 *
 * The generated types type this as `Record<string, unknown>[]`, so each field is
 * read through a guard rather than cast — a projection change in the SQL would
 * otherwise arrive as `undefined` in the URL of a link the member is about to
 * click.
 */
function firstRow(data: unknown): OutboundClickResult | null {
  if (!Array.isArray(data) || data.length === 0) return null

  const [row] = data as unknown[]

  if (typeof row !== 'object' || row === null) return null

  const { click_id: clickId, return_token: returnToken } = row as Record<string, unknown>

  if (typeof clickId !== 'string' || typeof returnToken !== 'string') return null

  return { clickId, returnToken }
}
