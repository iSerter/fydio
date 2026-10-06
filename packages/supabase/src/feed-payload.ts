import { z } from 'zod'

/**
 * Runtime parsing for `rank_feed`'s jsonb payload (T07).
 *
 * WHY THIS EXISTS AT ALL. PostgREST types a function returning `jsonb` as `Json` —
 * "some JSON value", which tells the compiler nothing about the shape. Casting that
 * to a typed interface with `as` compiles, runs, and hands the UI `undefined` for
 * every field the moment the function's projection changes. The failure surfaces as
 * a blank card, not a type error.
 *
 * So the payload is PARSED. The cost is one zod pass per row on the server; the
 * benefit is that a schema change to `rank_feed` fails the feed page loudly instead
 * of quietly rendering nothing.
 *
 * `reason_code` is deliberately `z.string()` rather than the four-code union. The
 * database enforces the vocabulary with a CHECK constraint, and a fifth reason
 * added to SQL before this file is updated should reach the member's screen and fail
 * `assertFeedReasonsMatchDomain` — not be rejected here by a stale parser, which
 * would break the feed for everyone rather than for one test.
 */

const hashtagSchema = z.object({
  id: z.string(),
  slug: z.string(),
  label: z.string(),
})

const authorSchema = z.object({
  id: z.string(),
  handle: z.string(),
  displayName: z.string(),
  avatarPath: z.string().nullable(),
  reputationTotal: z.number(),
})

export const feedEntryPayloadSchema = z.object({
  id: z.string(),
  platform: z.enum(['instagram', 'tiktok', 'youtube', 'x']),
  title: z.string().nullable(),
  captionExcerpt: z.string().nullable(),
  thumbnailPath: z.string().nullable(),
  thumbnailSource: z.string().nullable(),
  previewState: z.enum(['pending', 'resolved', 'unavailable', 'failed']),
  creatorNote: z.string().nullable(),
  asksForFeedback: z.boolean(),
  publishedAt: z.string(),
  originalUrl: z.string(),
  demoted: z.boolean(),
  author: authorSchema,
  tags: z.array(hashtagSchema),
})

const rankedRowSchema = z.object({
  rank: z.number(),
  entry: feedEntryPayloadSchema,
  score: z.string(),
  reason_code: z.string(),
})

/**
 * Parse one `rank_feed` row.
 *
 * Returns `null` for a row that does not parse rather than throwing. One malformed
 * entry — a row written by an older migration, say — should cost the member one
 * card, not the whole feed: the alternative is a blank page because a single entry
 * has a null it should not.
 */
export function parseRankedRow(value: unknown): RankedFeedRow | null {
  const parsed = rankedRowSchema.safeParse(value)

  if (!parsed.success) return null

  return parsed.data
}

/** Parse a whole page, dropping rows that do not parse. */
export function parseRankedRows(values: readonly unknown[]): RankedFeedRow[] {
  const rows: RankedFeedRow[] = []

  for (const value of values) {
    const row = parseRankedRow(value)

    if (row !== null) rows.push(row)
  }

  return rows
}

/** One parsed `rank_feed` row. */
export interface RankedFeedRow {
  readonly rank: number
  /**
   * The ranker's score, as EXACT TEXT.
   *
   * Not a number, and the parser keeps it that way. `rank_feed` returns `numeric`,
   * which carries more significant digits than an IEEE double holds; PostgREST sends
   * it as a JSON number, the browser rounds it, and sending that back as the next
   * page's cursor makes the boundary comparison fail — dropping an entry per page.
   * The string round-trips exactly.
   */
  readonly score: string
  readonly reason_code: string
  readonly entry: FeedEntryParsed
}

export type FeedEntryParsed = z.infer<typeof feedEntryPayloadSchema>