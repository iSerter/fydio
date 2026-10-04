import { NextResponse } from 'next/server'

import { requireUserId, memberClient } from '@/lib/server'

/**
 * Hashtag search and creation for the picker (T03).
 *
 * One endpoint for both, because the picker's two affordances are the same question asked at
 * different confidence levels: "does this tag exist?" and "if not, make it".
 *
 * AUTHORISATION. Reads run as the member (RLS `hashtags_read` already allows every member to
 * read the shared vocabulary). Creation runs through `create_hashtag`, which is SECURITY
 * DEFINER because 0009 restricts direct writes to admins, and which enforces the five-per-day
 * cap and normalises the label.
 *
 * RANKING. `is_official DESC, usage_count DESC, slug ASC`. Official tags first because the
 * community curates them; then by usage, because step 4 of onboarding is the highest-friction
 * screen and a new member should be able to reach a valid five-tag state in one pass. `slug`
 * breaks ties so the order is total -- an unstable order would make the list reshuffle
 * between keystrokes as counts change.
 */
export const dynamic = 'force-dynamic'

/** How many suggestions to return. Small on purpose: this is a picker, not a directory. */
const LIMIT = 20

export async function GET(request: Request): Promise<NextResponse> {
  await requireUserId()

  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const supabase = await memberClient()

  let select = supabase
    .from('hashtags')
    .select('id, slug, label, usage_count, is_official')
    .order('is_official', { ascending: false })
    .order('usage_count', { ascending: false })
    .order('slug', { ascending: true })
    .limit(LIMIT)

  // An empty query returns the most-used tags, which is what the picker shows before the
  // member types anything -- a blank list would give them no way to discover the vocabulary.
  if (query !== '') {
    // `ilike` on the slug rather than a full-text search: the vocabulary is ~40 tags, so a
    // sequential scan is faster than any index a real search would need.
    select = select.ilike('slug', `%${escapeForLike(query)}%`)
  }

  const { data, error } = await select

  if (error) {
    return NextResponse.json({ error: 'Could not load hashtags.' }, { status: 500 })
  }

  return NextResponse.json({ hashtags: data })
}

/**
 * Create a tag, or return the existing one.
 *
 * `create_hashtag` is idempotent by design, so a member confirming text that already exists
 * gets that tag back rather than an error they cannot act on.
 */
export async function POST(request: Request): Promise<NextResponse> {
  await requireUserId()

  let label: unknown

  try {
    const body: unknown = await request.json()
    label = typeof body === 'object' && body !== null ? (body as { label?: unknown }).label : null
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  if (typeof label !== 'string' || label.trim() === '') {
    return NextResponse.json({ error: 'Enter a hashtag.' }, { status: 400 })
  }

  const supabase = await memberClient()

  const { data, error } = await supabase.rpc('create_hashtag', { p_label: label.trim() })

  if (error) {
    // 23514 is `check_violation`, which is how the function reports a slug that cannot be
    // made valid, an over-long label, and the daily creation cap. Those are all member-facing
    // input problems, so the message is passed through rather than replaced.
    const isInputProblem = error.code === '23514'

    return NextResponse.json(
      { error: isInputProblem ? error.message : 'Could not create that hashtag.' },
      { status: isInputProblem ? 400 : 500 },
    )
  }

  return NextResponse.json({ hashtag: data })
}

/**
 * Neutralise the LIKE metacharacters in a member's query.
 *
 * `%` and `_` are wildcards, so an unescaped `_` would match any character -- someone
 * searching `snake_case` would also get `snake-case` and anything else nearby. Not a security
 * problem on this query, but it silently returns the wrong set.
 */
function escapeForLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`)
}