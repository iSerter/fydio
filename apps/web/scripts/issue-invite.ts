/**
 * Issue an invitation (T03).
 *
 * The admin UI for this lands in T09. This is the CLI equivalent so a developer can create a
 * working invitation locally without the console existing yet.
 *
 *   pnpm --filter @fydio/web exec tsx scripts/issue-invite.ts --email you@example.com
 *   pnpm --filter @fydio/web exec tsx scripts/issue-invite.ts --email a@b.test --role admin
 *
 * WHY THE TOKEN IS PRINTED AND NOT STORED. Only `sha256(token)` goes into the database, so a
 * leaked dump cannot be replayed -- but that also means the raw token exists ONLY at the moment
 * this script runs. Printing it once, here, is the entire delivery mechanism; a "resend" means
 * issuing a new invitation and revoking the old one.
 *
 * WHY IT USES THE SERVICE KEY. An invite is an administrative act and there is no member row
 * yet for the recipient, so `invites_admin_all` (RLS) cannot apply. The alternative -- a server
 * action behind an admin check -- is T09's job, not this script's.
 */
import { randomBytes } from 'node:crypto'

import { parseServerEnv } from '@fydio/env/server'

import { createServiceClient } from '@fydio/supabase/service'

import { inviteTokenHashParam } from '../src/lib/invite-token.js'

/** Arguments, parsed by hand rather than pulling in a CLI framework for four flags. */
interface Options {
  readonly email: string
  readonly role: 'member' | 'admin'
  readonly expiresInDays: number
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

  const email = values.get('email')

  if (email === undefined) {
    throw new Error('Usage: issue-invite.ts --email <address> [--role member|admin] [--days 7]')
  }

  const role = values.get('role') ?? 'member'

  if (role !== 'member' && role !== 'admin') {
    throw new Error(`--role must be "member" or "admin", got "${role}"`)
  }

  const rawDays = values.get('days') ?? '7'
  const expiresInDays = Number(rawDays)

  if (!Number.isInteger(expiresInDays) || expiresInDays <= 0) {
    throw new Error(`--days must be a positive whole number, got "${rawDays}"`)
  }

  return { email: email.trim().toLowerCase(), role, expiresInDays }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))

  // Validated through the same schema the app uses at boot, so a misconfigured environment
  // fails here with the variable name rather than as an undefined key deeper in.
  const env = parseServerEnv()

  // The service client from `@fydio/supabase/service` rather than a local `createClient`. That
  // package centralises the "service role bypasses RLS, so only call it where authorisation has
  // already been decided" rule; a script that built its own client would quietly opt out of
  // the convention every other caller follows.
  const admin = createServiceClient()

  const rawToken = randomBytes(32).toString('hex')

  // The `\x`-prefixed hex form comes from the shared helper, so the value written here and the
  // value compared at redemption cannot drift apart -- which is exactly the bug that would make
  // every invite fail with "Invalid invite" and no other symptom.
  const tokenHash = inviteTokenHashParam(rawToken)

  const expiresAt = new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000)

  const { error } = await admin.from('invites').insert({
    email: options.email,
    token_hash: tokenHash,
    role: options.role,
    expires_at: expiresAt.toISOString(),
  })

  if (error) {
    // A duplicate email is the realistic failure here -- `invites.email` is UNIQUE -- and it
    // deserves a specific message, because "invite someone new" and "reinvite the same person"
    // need different handling (revoke first).
    if (error.code === '23505') {
      throw new Error(
        `An invitation for ${options.email} already exists. Revoke it before issuing another.`,
      )
    }

    throw new Error(`Could not create the invitation: ${error.message}`)
  }

  const link = `${env.APP_URL.replace(/\/$/, '')}/invite/${rawToken}`

  console.log('\nInvitation created.\n')
  console.log(`  email:  ${options.email}`)
  console.log(`  role:   ${options.role}`)
  console.log(`  expires: ${expiresAt.toISOString()}`)
  console.log(`\n  link:  ${link}\n`)
  console.log('  This link is shown ONCE. Only its SHA-256 digest is stored, so it cannot be')
  console.log('  recovered later -- issue a new invitation if it is lost.\n')
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : 'unknown failure'}\n`)
  process.exitCode = 1
})