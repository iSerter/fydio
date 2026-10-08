import { createHash } from 'node:crypto'

import { normalizeInviteCode } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

export type InviteCodeStatus = 'valid' | 'invalid' | 'expired' | 'revoked' | 'exhausted'

export interface InviteCodeStatusResult {
  readonly status: InviteCodeStatus
  readonly normalizedCode?: string
  readonly label?: string | null
}

/**
 * SHA-256 digest of a normalised invite code, as lowercase hex string.
 *
 * `claim_invite_code` compares this against `invite_codes.code_hash`.
 */
export function hashInviteCode(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode, 'utf8').digest('hex')
}

/**
 * The digest in `\x`-prefixed hex form for PostgREST `bytea` comparisons.
 */
export function inviteCodeHashParam(normalizedCode: string): string {
  return `\\x${hashInviteCode(normalizedCode)}`
}

/**
 * Read-only status check for a code (T11 §5.8).
 *
 * Called server-side from `/join/[code]` using the service key so an anonymous visitor
 * can see if a link is valid before entering an email address.
 *
 * NOTE: The remaining count is NEVER exposed to visitors to prevent oracle attacks.
 */
export async function checkInviteCodeStatus(rawCode: string): Promise<InviteCodeStatusResult> {
  let normalized: string
  try {
    normalized = normalizeInviteCode(rawCode)
  } catch {
    return { status: 'invalid' }
  }

  if (normalized.length < 16 || normalized.length > 32) {
    return { status: 'invalid' }
  }

  const admin = createServiceClient()
  const { data, error } = await admin
    .from('invite_codes')
    .select('id, max_uses, used_count, expires_at, revoked_at, label')
    .eq('code_hash', inviteCodeHashParam(normalized))
    .maybeSingle()

  if (error || !data) {
    return { status: 'invalid' }
  }

  if (data.revoked_at !== null) {
    return { status: 'revoked' }
  }

  if (data.expires_at !== null && new Date(data.expires_at).getTime() < Date.now()) {
    return { status: 'expired' }
  }

  if (data.used_count >= data.max_uses) {
    return { status: 'exhausted' }
  }

  return { status: 'valid', normalizedCode: normalized, label: data.label }
}
