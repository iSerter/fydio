/**
 * Issue a limited-use invite code (T11 §5.10).
 *
 * CLI equivalent of the /admin/invites console, allowing an admin or developer
 * to mint a batch invite link directly.
 *
 *   pnpm --filter @fydio/web invite:code --uses 5
 *   pnpm --filter @fydio/web invite:code --uses 10 --label "march newsletter" --days 14
 */

import { generateInviteCode } from '@fydio/domain'
import { parseServerEnv } from '@fydio/env/server'
import { createServiceClient } from '@fydio/supabase/service'

import { inviteCodeHashParam } from '../src/lib/invite-code.js'

interface Options {
  readonly uses: number
  readonly label?: string | undefined
  readonly days?: number | undefined
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Flag ${token} needs a value`)
    }

    values.set(token.slice(2), next)
    index += 1
  }

  const rawUses = values.get('uses')
  if (rawUses === undefined) {
    throw new Error('Usage: issue-invite-code.ts --uses <count> [--label "batch name"] [--days 14]')
  }

  const uses = Number(rawUses)
  if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
    throw new Error(`--uses must be an integer between 1 and 1000, got "${rawUses}"`)
  }

  const label = values.get('label')?.trim()

  const rawDays = values.get('days')
  let days: number | undefined
  if (rawDays !== undefined) {
    days = Number(rawDays)
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`--days must be a positive whole number, got "${rawDays}"`)
    }
  }

  return { uses, label, days }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const env = parseServerEnv()
  const admin = createServiceClient()

  const rawCode = generateInviteCode(20)
  const codeHash = inviteCodeHashParam(rawCode)

  const expiresAt =
    options.days !== undefined
      ? new Date(Date.now() + options.days * 24 * 60 * 60 * 1000)
      : null

  const { error } = await admin.from('invite_codes').insert({
    label: options.label ?? null,
    code_hash: codeHash,
    code_length: 20,
    max_uses: options.uses,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
  })

  if (error) {
    throw new Error(`Could not create invite code: ${error.message}`)
  }

  const link = `${env.APP_URL.replace(/\/$/, '')}/join/${rawCode}`

  console.log('\nInvite code created.\n')
  console.log(`  label:   ${options.label ?? '(none)'}`)
  console.log(`  uses:    0/${options.uses}`)
  console.log(`  expires: ${expiresAt ? expiresAt.toISOString() : 'never'}`)
  console.log(`\n  link:    ${link}\n`)
  console.log('  This link is shown ONCE. Only its SHA-256 digest is stored, so it cannot be')
  console.log('  recovered later -- mint a new code if it is lost.\n')
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})
