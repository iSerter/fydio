import { describe, expect, it } from 'vitest'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { generateInviteCode } from '@fydio/domain'
import type { Database } from '@fydio/supabase'

import { inviteCodeHashParam } from '@/lib/invite-code'

const createClient = createSupabaseClient

const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const appUrl = process.env.APP_URL

const describeIfStack =
  supabaseUrl && anonKey && serviceKey && appUrl ? describe : describe.skip

describeIfStack('T11 Limited-use invite codes HTTP surface', () => {
  const db = createClient<Database>(supabaseUrl ?? '', serviceKey ?? '', {
    auth: { persistSession: false },
  })

  it('rejects a malformed code before checking database', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'short', email: 'test@demo.test' }),
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toContain('not valid')
  })

  it('rejects an invalid email format', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'K4M9QR7XZ2AB8HJTC5VN', email: 'not-an-email' }),
    })

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toContain('valid email')
  })

  it('reports a well-formed but non-existent code as 404', async () => {
    const response = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'K4M9QR7XZ2AB8HJTC5VN', email: 'random@demo.test' }),
    })

    expect(response.status).toBe(404)
    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toContain('not valid')
  })

  it('redeems a capped code up to max_uses and rejects subsequent attempts with 410', async () => {
    const rawCode = generateInviteCode(20)
    const hashParam = inviteCodeHashParam(rawCode)

    // Mint a code with max_uses = 2
    const { error: insertError } = await db.from('invite_codes').insert({
      label: 'integration-test-2uses',
      code_hash: hashParam,
      code_length: 20,
      max_uses: 2,
    })
    expect(insertError).toBeNull()

    const email1 = `t11-user1-${Date.now()}@demo.test`
    const email2 = `t11-user2-${Date.now()}@demo.test`
    const email3 = `t11-user3-${Date.now()}@demo.test`

    // Claim 1: first user
    const res1 = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawCode, email: email1 }),
    })
    expect(res1.status).toBe(200)
    const payload1 = (await res1.json()) as { ok?: boolean; signedIn?: boolean; sessionToken?: string }
    expect(payload1.ok).toBe(true)
    expect(payload1.signedIn).toBe(true)
    expect(payload1.sessionToken).toBeDefined()

    // Assert used_count = 1
    const { data: codeRow1 } = await db
      .from('invite_codes')
      .select('used_count')
      .eq('code_hash', hashParam)
      .single()
    expect(codeRow1?.used_count).toBe(1)

    // Replay with email1: rejected with 409 because email already registered, does not consume slot
    const resReplay = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawCode, email: email1 }),
    })
    expect(resReplay.status).toBe(409)

    const { data: codeRowReplay } = await db
      .from('invite_codes')
      .select('used_count')
      .eq('code_hash', hashParam)
      .single()
    expect(codeRowReplay?.used_count).toBe(1)

    // Claim 2: second user (last slot)
    const res2 = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawCode.toLowerCase(), email: email2 }), // test case normalization
    })
    expect(res2.status).toBe(200)
    const payload2 = (await res2.json()) as { ok?: boolean }
    expect(payload2.ok).toBe(true)

    // Assert used_count = 2 (cap reached)
    const { data: codeRow2 } = await db
      .from('invite_codes')
      .select('used_count')
      .eq('code_hash', hashParam)
      .single()
    expect(codeRow2?.used_count).toBe(2)

    // Claim 3: third user (exhausted)
    const res3 = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawCode, email: email3 }),
    })
    expect(res3.status).toBe(410)
    const payload3 = (await res3.json()) as { error?: string }
    expect(payload3.error).toContain('already joined')

    // Verify raw code is never stored on disk
    const { data: onDisk } = await db
      .from('invite_codes')
      .select('code_hash')
      .eq('code_hash', hashParam)
      .single()
    expect(String(onDisk?.code_hash)).not.toContain(rawCode)
  })

  it('refuses revoked and expired codes with 410', async () => {
    const rawRevoked = generateInviteCode(20)
    const rawExpired = generateInviteCode(20)

    await db.from('invite_codes').insert([
      {
        code_hash: inviteCodeHashParam(rawRevoked),
        code_length: 20,
        max_uses: 5,
        revoked_at: new Date().toISOString(),
      },
      {
        code_hash: inviteCodeHashParam(rawExpired),
        code_length: 20,
        max_uses: 5,
        expires_at: new Date(Date.now() - 3600_000).toISOString(),
      },
    ])

    const resRevoked = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawRevoked, email: `revoked-${Date.now()}@demo.test` }),
    })
    expect(resRevoked.status).toBe(410)

    const resExpired = await fetch(`${appUrl ?? ''}/api/auth/accept-invite-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: rawExpired, email: `expired-${Date.now()}@demo.test` }),
    })
    expect(resExpired.status).toBe(410)
  })
})
