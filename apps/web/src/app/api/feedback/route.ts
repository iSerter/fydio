import { NextResponse } from 'next/server'
import { z } from 'zod'

import { FEEDBACK_TAGS } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Leave feedback with credit evaluation (T05 credit side; UI in T09).
 *
 * Two calls, two privilege levels — the same split the database enforces:
 * `submit_feedback` runs as the member (it is their words), while
 * `evaluate_feedback_eligibility` runs as the service role (earning is a job
 * decision, revoked from `authenticated` in 0009 so no member can self-deal
 * or release early).
 *
 * Short notes are ACCEPTED here: the database stores bodies down to 10
 * characters as ineligible rather than refusing them. The 40-character
 * quality bar lives in the T09 composer, not in this route — refusing a short
 * note would be worse product than storing one that earns nothing.
 */
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  entryId: z.uuid(),
  body: z.string().trim().min(10, 'Feedback is too short.').max(4000, 'Feedback is too long.'),
  tags: z.array(z.enum(FEEDBACK_TAGS)).default([]),
  imagePaths: z.array(z.string().min(1)).max(3).default([]),
})

export async function POST(request: Request): Promise<NextResponse> {
  await requireUserId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'That feedback is not valid.' }, { status: 400 })
  }

  const supabase = await memberClient()

  const { data: feedback, error: submitError } = await supabase.rpc('submit_feedback', {
    p_entry_id: parsed.data.entryId,
    p_body: parsed.data.body,
    p_tags: parsed.data.tags,
    p_image_paths: parsed.data.imagePaths,
  })

  // Mirrors the entries route: a failed RPC carries the reason, and `data`
  // is only read when there is none.
  if (submitError) {
    return mapSubmitError(submitError.code, submitError.message)
  }

  // Earning decision, as the job. A failure here must not fail the feedback:
  // the words are stored and the member is told; the next sweeper pass (or a
  // retry) can evaluate later, and evaluation is idempotent.
  const service = createServiceClient()
  const { data: eligibility, error: eligibilityError } = await service.rpc(
    'evaluate_feedback_eligibility',
    { p_feedback_id: feedback.id },
  )

  if (eligibilityError) {
    return NextResponse.json(
      { ok: true, feedback, eligibility: feedback.eligibility, evaluationPending: true },
      { status: 201 },
    )
  }

  return NextResponse.json(
    {
      ok: true,
      feedback,
      eligibility,
      creditHeld: eligibility === 'eligible',
    },
    { status: 201 },
  )
}

function mapSubmitError(code: string | undefined, message: string | undefined): NextResponse {
  const text = message ?? 'That feedback could not be saved.'
  if (text.includes('own content')) {
    return NextResponse.json(
      { error: 'You cannot leave feedback on your own content.' },
      { status: 400 },
    )
  }
  if (text.includes('Open the content')) {
    return NextResponse.json(
      { error: 'Open the content before leaving feedback.' },
      { status: 403 },
    )
  }
  if (text.includes('already left feedback')) {
    return NextResponse.json({ error: 'You already left feedback on this entry.' }, { status: 409 })
  }
  if (text.includes('Blocked account')) {
    return NextResponse.json({ error: 'That action is not allowed.' }, { status: 403 })
  }
  if (code === '42501') {
    return NextResponse.json({ error: 'That action is not allowed.' }, { status: 403 })
  }
  return NextResponse.json({ error: 'That feedback could not be saved.' }, { status: 500 })
}
