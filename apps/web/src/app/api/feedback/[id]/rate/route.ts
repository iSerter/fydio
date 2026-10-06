import { NextResponse } from 'next/server'
import { z } from 'zod'

import { assertValidRating } from '@fydio/domain'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Rate a feedback item 1–10 (T06 RPC entry point; rating modal UI lands in T09).
 *
 * Thin wrapper over `rate_feedback`: the database enforces owner-only,
 * rate-once, no self-rating and the 1–10 range, and this route only maps those
 * errors to status codes. Revisions use the same route with PUT (T09 inbox
 * calls it); creation uses POST.
 */
export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.uuid() })
const bodySchema = z.object({ score: z.number().int().min(1).max(10) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  await requireUserId()
  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'That feedback does not exist.' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Rating must be between 1 and 10.' }, { status: 400 })
  }
  assertValidRating(parsed.data.score)

  const supabase = await memberClient()
  const { data, error } = await supabase.rpc('rate_feedback', {
    p_feedback_id: parsedParams.data.id,
    p_score: parsed.data.score,
  })

  if (error) {
    return mapRatingError(error.message)
  }
  return NextResponse.json({ ok: true, rating: data }, { status: 201 })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  await requireUserId()
  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'That feedback does not exist.' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Rating must be between 1 and 10.' }, { status: 400 })
  }

  const supabase = await memberClient()
  const { data, error } = await supabase.rpc('revise_rating', {
    p_feedback_id: parsedParams.data.id,
    p_score: parsed.data.score,
  })

  if (error) {
    return mapRatingError(error.message)
  }
  return NextResponse.json({ ok: true, rating: data })
}

function mapRatingError(message: string | undefined): NextResponse {
  const text = message ?? ''
  if (text.includes('Only the content owner') || text.includes('Only the original rater')) {
    return NextResponse.json(
      { error: 'Only the entry owner can rate this feedback.' },
      { status: 403 },
    )
  }
  if (text.includes('already been rated')) {
    return NextResponse.json({ error: 'This feedback has already been rated.' }, { status: 409 })
  }
  if (text.includes('Self-rating') || text.includes('own content')) {
    return NextResponse.json({ error: 'You cannot rate your own feedback.' }, { status: 400 })
  }
  if (text.includes('between 1 and 10')) {
    return NextResponse.json({ error: 'Rating must be between 1 and 10.' }, { status: 400 })
  }
  if (text.includes('window has closed')) {
    return NextResponse.json({ error: 'The revision window has closed.' }, { status: 400 })
  }
  if (text.includes('Removed feedback')) {
    return NextResponse.json({ error: 'Removed feedback cannot be rated.' }, { status: 400 })
  }
  return NextResponse.json({ error: 'That rating could not be saved.' }, { status: 500 })
}
