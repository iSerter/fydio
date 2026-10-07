import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  FEEDBACK_COPY,
  REPORT_TARGETS,
  REPORT_REASONS,
  meetsQualityGate,
  isWithinFeedbackEditGrace,
  isWithinRatingRevisionWindow,
  submitFeedbackSchema,
  submitReportSchema,
} from '@fydio/domain'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@fydio/supabase'

const supabaseUrl = process.env.SUPABASE_URL ?? ''
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

const describeIfStack = supabaseUrl && anonKey && serviceKey ? describe : describe.skip

describe('feedback & moderation domain invariants', () => {
  it('strictly validates feedback character count and image limits', () => {
    // < 10 chars fails
    const tooShort = submitFeedbackSchema.safeParse({
      entryId: '550e8400-e29b-41d4-a716-446655440000',
      body: 'Too short',
    })
    expect(tooShort.success).toBe(false)

    // Valid 10 chars passes
    const valid = submitFeedbackSchema.safeParse({
      entryId: '550e8400-e29b-41d4-a716-446655440000',
      body: '1234567890',
      tags: ['hook', 'clarity'],
    })
    expect(valid.success).toBe(true)

    // > 3 images fails
    const tooManyImages = submitFeedbackSchema.safeParse({
      entryId: '550e8400-e29b-41d4-a716-446655440000',
      body: 'Valid feedback body with enough characters.',
      imagePaths: ['img1.webp', 'img2.webp', 'img3.webp', 'img4.webp'],
    })
    expect(tooManyImages.success).toBe(false)
  })

  it('evaluates the live quality gate correctly', () => {
    // 40+ chars with 0 images passes
    expect(meetsQualityGate('a'.repeat(40), 0)).toBe(true)

    // 39 chars with 0 images fails
    expect(meetsQualityGate('a'.repeat(39), 0)).toBe(false)

    // 10 chars with 1 image passes
    expect(meetsQualityGate('a'.repeat(10), 1)).toBe(true)

    // 10 chars with 0 images fails quality gate (even though schema allows submitting)
    expect(meetsQualityGate('a'.repeat(10), 0)).toBe(false)
  })

  it('enforces the 48-hour edit grace window', () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 10 * 60 * 1000).toISOString() // 10 mins ago
    const expired = new Date(now.getTime() - 49 * 60 * 60 * 1000).toISOString() // 49 hours ago

    expect(isWithinFeedbackEditGrace(recent)).toBe(true)
    expect(isWithinFeedbackEditGrace(expired)).toBe(false)
  })

  it('enforces the 24-hour rating revision window', () => {
    const now = new Date()
    const recent = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    const expired = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() // 25 hours ago

    expect(isWithinRatingRevisionWindow(recent)).toBe(true)
    expect(isWithinRatingRevisionWindow(expired)).toBe(false)
  })

  it('validates report targets and reasons according to specification', () => {
    expect(REPORT_TARGETS).toEqual(['content_entry', 'feedback', 'user', 'hashtag'])

    for (const target of REPORT_TARGETS) {
      const validReasons = REPORT_REASONS[target]
      expect(validReasons.length).toBeGreaterThan(0)

      const parsed = submitReportSchema.safeParse({
        targetType: target,
        targetId: '550e8400-e29b-41d4-a716-446655440000',
        reason: validReasons[0],
        details: 'Testing reporting',
      })
      expect(parsed.success).toBe(true)
    }

    // Invalid reason for target fails
    const invalid = submitReportSchema.safeParse({
      targetType: 'feedback',
      targetId: '550e8400-e29b-41d4-a716-446655440000',
      reason: 'broken_link', // only valid for content_entry
    })
    expect(invalid.success).toBe(false)
  })

  it('maintains strict copy guard: never "points" or "pts" in user-facing copy', () => {
    // 1. Check FEEDBACK_COPY constants
    const copyStrings = Object.values(FEEDBACK_COPY)
    for (const str of copyStrings) {
      expect(str.toLowerCase()).not.toMatch(/\bpoints\b/)
      expect(str.toLowerCase()).not.toMatch(/\bpts\b/)
    }

    // 2. Scan feedback components and pages
    const webSrc = join(process.cwd(), 'src')
    const scanFiles = [
      join(webSrc, 'components', 'feedback', 'FeedbackComposer.tsx'),
      join(webSrc, 'components', 'feedback', 'FeedbackCard.tsx'),
      join(webSrc, 'components', 'feedback', 'RatingInput.tsx'),
      join(webSrc, 'components', 'feedback', 'ReportDialog.tsx'),
      join(webSrc, 'app', '(app)', 'inbox', 'page.tsx'),
      join(webSrc, 'app', '(app)', 'dashboard', 'page.tsx'),
      join(webSrc, 'app', '(app)', 'dashboard', 'feedback', 'page.tsx'),
    ]

    for (const filePath of scanFiles) {
      const content = readFileSync(filePath, 'utf8')
      // Ensure no standalone word "points" or "pts"
      const match = /\b(points|pts)\b/i.exec(content)
      expect(match, `Found forbidden points terminology in ${filePath}`).toBeNull()
    }
  })
})

describeIfStack('live-stack feedback & moderation integration', () => {
  const service = createSupabaseClient<Database>(supabaseUrl, serviceKey)
  let testMemberClient: ReturnType<typeof createSupabaseClient<Database>>
  let testMemberId: string

  beforeAll(async () => {
    const email = `t09-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@demo.test`
    const { data: userRes, error: createErr } = await service.auth.admin.createUser({
      email,
      password: 'test-password-123',
      email_confirm: true,
    })
    if (createErr) {
      throw new Error(`Failed to create test user: ${createErr.message}`)
    }
    testMemberId = userRes.user.id

    await service.from('profiles').upsert({
      id: testMemberId,
      handle: `t09_${Date.now()}`.slice(0, 20),
      display_name: 'Test Member',
      role: 'member',
    })

    const client = createSupabaseClient<Database>(supabaseUrl, anonKey, {
      auth: { persistSession: false },
    })
    const { error: signInErr } = await client.auth.signInWithPassword({
      email,
      password: 'test-password-123',
    })
    if (signInErr) throw new Error(`Sign in failed: ${signInErr.message}`)
    testMemberClient = client
  })

  it('prohibits non-admin members from resolving reports via RPC', async () => {
    const { error } = await testMemberClient.rpc('admin_resolve_report', {
      p_report_id: '550e8400-e29b-41d4-a716-446655440000',
      p_state: 'resolved',
    })

    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/admin only/i)
  })

  it('prohibits non-admin members from changing user roles via RPC', async () => {
    const { error } = await testMemberClient.rpc('admin_set_role', {
      p_user_id: '550e8400-e29b-41d4-a716-446655440000',
      p_role: 'admin',
    })

    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/admin only/i)
  })

  it('allows members to file reports via report_content RPC', async () => {
    // Find any existing content entry
    const { data: entry } = await service
      .from('content_entries')
      .select('id')
      .limit(1)
      .single()

    if (!entry) return

    const { data: report, error } = await testMemberClient.rpc('report_content', {
      p_target_type: 'content_entry',
      p_target_id: entry.id,
      p_reason: 'spam',
      p_details: 'Automated integration test report',
    })

    expect(error).toBeNull()
    const reportId = report?.id
    expect(reportId).toBeDefined()
    if (!reportId) throw new Error('Expected report id')

    // Verify report exists in moderation_reports
    const { data: savedReport } = await service
      .from('moderation_reports')
      .select('*')
      .eq('id', reportId)
      .single()

    expect(savedReport?.target_id).toBe(entry.id)
    expect(savedReport?.reason).toBe('spam')
    expect(savedReport?.state).toBe('open')
  })
})
