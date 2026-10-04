/**
 * Release due held Credits (T05 sweeper one-shot).
 *
 *   pnpm --filter @fydio/web credits:release-held
 *
 * Calls the same `release_held_credits()` RPC the hourly scheduler (T10) and
 * the `/api/cron/release-held` route call. Releasing is safe and idempotent,
 * so this is the mechanism for CLI/CI use — for example, an E2E test that
 * earned a held credit and does not want to wait out the review window.
 */
import { createServiceClient } from '@fydio/supabase/service'

async function main(): Promise<void> {
  const admin = createServiceClient()

  const { data: released, error } = await admin.rpc('release_held_credits')

  if (error) {
    throw new Error(`Could not release held Credits: ${error.message}`)
  }

  console.log(`Released ${released} held Credits.`)
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
