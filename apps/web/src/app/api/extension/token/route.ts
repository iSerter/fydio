import { NextResponse } from 'next/server'

import { issueExtensionToken } from '@/lib/extension-tokens'
import { requireUserId } from '@/lib/server'

/**
 * Extension token provisioning endpoint (T10).
 *
 * Mints a scoped, short-lived extension token for the currently authenticated member.
 * The companion Chrome extension uses this token to authenticate telemetry reports
 * to `/api/telemetry/duration`.
 */
export const dynamic = 'force-dynamic'

export async function POST(): Promise<NextResponse> {
  const userId = await requireUserId()

  try {
    const token = issueExtensionToken({
      userId,
      scope: 'telemetry:duration',
    })

    return NextResponse.json(
      {
        ok: true,
        token,
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('issueExtensionToken failed:', error)

    return NextResponse.json(
      { error: 'Extension token service is not configured or unavailable.' },
      { status: 503 },
    )
  }
}
