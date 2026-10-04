/**
 * Give a test member starter Credits (T04 E2E support).
 *
 *   pnpm --filter @fydio/web exec tsx --conditions=react-server --env-file=../../.env scripts/grant-allowance.ts --email <member>
 *
 * A member created mid-test has never seen the weekly sweeper, so their balance
 * is zero and every submission would fail with "Insufficient Credits" -- which
 * tests the guard, not the submission flow. The sweeper itself cannot help: it
 * is idempotent per week and this week's run already happened.
 *
 * So this inserts the same row the sweeper would have written
 * (`weekly_allowance`, `available`), for this member only, via the service
 * client. Test seeding, not a business path: no route or RPC calls it.
 */
import { createServiceClient } from '@fydio/supabase/service'

const AMOUNT = 3

async function main(): Promise<void> {
  const email = process.argv
    .slice(2)
    .find((arg, index, argv) => argv[index - 1] === '--email' && !arg.startsWith('--'))

  if (!email) {
    throw new Error('Usage: grant-allowance.ts --email <member-address>')
  }

  const admin = createServiceClient()

  const { data: invite, error: inviteError } = await admin
    .from('invites')
    .select('accepted_by')
    .eq('email', email.trim().toLowerCase())
    .not('accepted_by', 'is', null)
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (inviteError || !invite?.accepted_by) {
    throw new Error(`No redeemed invitation for ${email}: accept the invite first.`)
  }

  const { error } = await admin.from('credit_ledger').insert({
    user_id: invite.accepted_by,
    delta: AMOUNT,
    kind: 'weekly_allowance',
    status: 'available',
    note: 'E2E starter grant',
  })

  if (error) {
    throw new Error(`Could not grant starter Credits: ${error.message}`)
  }

  console.log(`Granted ${AMOUNT} starter Credits to ${email}.`)
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
