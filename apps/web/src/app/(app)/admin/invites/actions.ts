'use server'

import { revalidatePath } from 'next/cache'

import { generateInviteCode } from '@fydio/domain'
import { createServiceClient } from '@fydio/supabase/service'

import { currentUserId, memberClient } from '@/lib/server'
import { inviteCodeHashParam } from '@/lib/invite-code'

async function requireAdmin(): Promise<string> {
  const userId = await currentUserId()
  if (!userId) {
    throw new Error('Unauthorized: must be signed in')
  }

  const client = await memberClient()
  const { data: profile } = await client
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (profile?.role !== 'admin') {
    throw new Error('Forbidden: administrator privilege required')
  }

  return userId
}

export interface CreateInviteCodeResult {
  readonly ok: boolean
  readonly rawCode?: string
  readonly error?: string
}

export async function createInviteCodeAction(
  _prevState: unknown,
  formData: FormData,
): Promise<CreateInviteCodeResult> {
  try {
    const adminUserId = await requireAdmin()

    const rawMaxUses = formData.get('max_uses')
    const rawLabel = formData.get('label')
    const rawDays = formData.get('days')

    const maxUses = Number(rawMaxUses)
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
      return { ok: false, error: 'Max uses must be a whole number between 1 and 1000.' }
    }

    const label = typeof rawLabel === 'string' && rawLabel.trim().length > 0 ? rawLabel.trim() : null

    let expiresAt: string | null = null
    if (typeof rawDays === 'string' && rawDays.trim().length > 0) {
      const days = Number(rawDays)
      if (!Number.isInteger(days) || days <= 0) {
        return { ok: false, error: 'Expiration days must be a positive integer.' }
      }
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    }

    const rawCode = generateInviteCode(20)
    const codeHash = inviteCodeHashParam(rawCode)

    const admin = createServiceClient()
    const { error } = await admin.from('invite_codes').insert({
      label,
      code_hash: codeHash,
      code_length: 20,
      max_uses: maxUses,
      created_by: adminUserId,
      expires_at: expiresAt,
    })

    if (error) {
      return { ok: false, error: `Could not create invite code: ${error.message}` }
    }

    revalidatePath('/admin/invites')
    return { ok: true, rawCode }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

export async function revokeInviteCodeAction(codeId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireAdmin()

    const admin = createServiceClient()
    const { error } = await admin
      .from('invite_codes')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', codeId)

    if (error) {
      return { ok: false, error: error.message }
    }

    revalidatePath('/admin/invites')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
