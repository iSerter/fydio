import { timingSafeEqual } from 'node:crypto'

import { getServerEnv } from '@fydio/env/server'

/**
 * Shared guard for the T05 cron routes.
 *
 * Coolify Scheduler (T10) calls these routes with the `x-cron-secret` header.
 * The comparison is timing-safe so a wrong secret costs an attacker as much
 * per guess as possible — cheap insurance on an endpoint that mints Credits.
 *
 * Returns an error response when the call is refused, or `null` when it may
 * proceed. A missing `CRON_SECRET` refuses everything: an unguarded minting
 * endpoint must not exist even in dev.
 */
export function refuseCron(request: Request): Response | null {
  const secret = getServerEnv().CRON_SECRET

  if (!secret) {
    return Response.json({ error: 'Scheduled jobs are not configured.' }, { status: 503 })
  }

  const presented = request.headers.get('x-cron-secret') ?? ''
  const expected = Buffer.from(secret, 'utf8')
  const actual = Buffer.from(presented, 'utf8')

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: 'That action is not allowed.' }, { status: 403 })
  }

  return null
}
