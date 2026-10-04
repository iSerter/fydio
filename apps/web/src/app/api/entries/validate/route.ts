import { NextResponse } from 'next/server'

import { detectSubmission } from '@fydio/domain'

import { platformAllowlist } from '@/lib/env'
import { resolvePreviewSafely } from '@/lib/preview'
import { requireUserId } from '@/lib/server'

/**
 * Live URL validation for the /submit form (T04).
 *
 * POST { url } -> { platform, canonicalUrl, allowed, preview } or 400.
 * Preview is a best-effort probe; its absence never fails validation.
 */
export const dynamic = 'force-dynamic'

const bodySchema = {
  safeParse(body: unknown): { success: boolean; data?: { url: string } } {
    if (typeof body !== 'object' || body === null) return { success: false }
    const url = (body as { url?: unknown }).url
    if (typeof url !== 'string' || url.trim().length === 0) return { success: false }
    return { success: true, data: { url } }
  },
}

export async function POST(request: Request): Promise<NextResponse> {
  await requireUserId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success || !parsed.data) {
    return NextResponse.json({ error: 'Enter a link.' }, { status: 400 })
  }

  const detected = detectSubmission(parsed.data.url)
  if (!detected) {
    return NextResponse.json(
      { error: 'That link is not a supported post on Instagram, TikTok, YouTube, or X.' },
      { status: 400 },
    )
  }

  if (!platformAllowlist().includes(detected.platform)) {
    return NextResponse.json(
      { error: `${detected.platform} is not currently allowed.` },
      { status: 400 },
    )
  }

  const preview = await resolvePreviewSafely({ url: detected.canonicalUrl, platform: detected.platform })

  return NextResponse.json({
    platform: detected.platform,
    canonicalUrl: detected.canonicalUrl,
    preview,
  })
}
