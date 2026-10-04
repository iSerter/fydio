/**
 * Run the weekly starter-credit allowance (T05 one-shot).
 *
 *   pnpm --filter @fydio/web credits:grant-weekly
 *
 * Calls the same idempotent `grant_weekly_allowance()` RPC the scheduler
 * (T10) and the `/api/cron/weekly-allowance` route call. A second invocation
 * in the same ISO week grants nothing — the `weekly_allowance_runs` period
 * key, not the caller, is what makes double-grants impossible.
 */
import { createServiceClient } from '@fydio/supabase/service'

async function main(): Promise<void> {
  const admin = createServiceClient()

  const { data: granted, error } = await admin.rpc('grant_weekly_allowance')

  if (error) {
    throw new Error(`Could not grant the weekly allowance: ${error.message}`)
  }

  console.log(`Granted the weekly allowance to ${granted} members.`)
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
