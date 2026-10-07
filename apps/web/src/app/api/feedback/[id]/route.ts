import { NextResponse } from 'next/server'
import { z } from 'zod'

import { FEEDBACK_TAGS, MAX_FEEDBACK_IMAGES } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.uuid() })

const updateSchema = z.object({
  body: z.string().trim().min(10, 'Feedback is too short.').max(4000, 'Feedback is too long.'),
  tags: z.array(z.enum(FEEDBACK_TAGS)).default([]),
  imagePaths: z.array(z.string().min(1)).max(MAX_FEEDBACK_IMAGES).default([]),
})

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

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'That feedback update is not valid.' }, { status: 400 })
  }

  const supabase = await memberClient()
  const { data: updated, error: updateError } = await supabase.rpc('update_feedback', {
    p_feedback_id: parsedParams.data.id,
    p_body: parsed.data.body,
    p_tags: parsed.data.tags,
    p_image_paths: parsed.data.imagePaths,
  })

  if (updateError) {
    return mapUpdateError(updateError.message)
  }

  // If eligibility was reset to pending, evaluate it with service client
  let finalEligibility = updated.eligibility
  if (updated.eligibility === 'pending') {
    const service = createServiceClient()
    const { data: evaluated } = await service.rpc('evaluate_feedback_eligibility', {
      p_feedback_id: updated.id,
    })
    if (evaluated) {
      finalEligibility = evaluated
    }
  }

  return NextResponse.json({
    ok: true,
    feedback: updated,
    eligibility: finalEligibility,
    creditHeld: finalEligibility === 'eligible',
  })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  await requireUserId()

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'That feedback does not exist.' }, { status: 404 })
  }

  const supabase = await memberClient()
  const { data, error } = await supabase.rpc('remove_feedback', {
    p_feedback_id: parsedParams.data.id,
  })

  if (error) {
    return mapRemoveError(error.message)
  }

  return NextResponse.json({ ok: true, feedback: data })
}

function mapUpdateError(message: string | undefined): NextResponse {
  const text = message ?? ''
  if (text.includes('Feedback not found')) {
    return NextResponse.json({ error: 'Feedback not found.' }, { status: 404 })
  }
  if (text.includes('only edit your own feedback')) {
    return NextResponse.json({ error: 'You can only edit your own feedback.' }, { status: 403 })
  }
  if (text.includes('Rated feedback cannot be edited')) {
    return NextResponse.json({ error: 'Rated feedback cannot be edited.' }, { status: 400 })
  }
  if (text.includes('grace period has expired')) {
    return NextResponse.json({ error: 'The edit grace period has expired.' }, { status: 400 })
  }
  if (text.includes('Removed feedback cannot be edited')) {
    return NextResponse.json({ error: 'Removed feedback cannot be edited.' }, { status: 400 })
  }
  return NextResponse.json({ error: 'That feedback could not be updated.' }, { status: 500 })
}

function mapRemoveError(message: string | undefined): NextResponse {
  const text = message ?? ''
  if (text.includes('Feedback not found')) {
    return NextResponse.json({ error: 'Feedback not found.' }, { status: 404 })
  }
  if (text.includes('only remove your own feedback')) {
    return NextResponse.json({ error: 'You can only remove your own feedback.' }, { status: 403 })
  }
  if (text.includes('Feedback already removed')) {
    return NextResponse.json({ error: 'This feedback was already removed.' }, { status: 409 })
  }
  return NextResponse.json({ error: 'That feedback could not be removed.' }, { status: 500 })
}
