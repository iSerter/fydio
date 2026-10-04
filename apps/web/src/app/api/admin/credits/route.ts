import { NextResponse } from 'next/server'
import { z } from 'zod'

import { createServiceClient } from '@fydio/supabase/service'

import { memberClient, requireUserId } from '@/lib/server'

/**
 * Admin credit operations (T05).
 *
 * Three audited tools plus the future-only ceiling:
 *
 * - `grant` — adds Credits (onboarding fixes, good faith). Audited by the RPC.
 * - `reverse` — claws back one ledger row. Audited by the RPC.
 * - `cap` — the 0010 clawback-to-ceiling. Audited by the RPC.
 * - `ceiling` — caps FUTURE earning without touching history. The
 *   `moderation_actions` row IS the audit trail (append-only), and
 *   `evaluate_feedback_eligibility` enforces it.
 *
 * Every path re-checks admin twice: the route refuses non-admins before the
 * service client is even constructed, and each RPC re-checks `is_admin()`
 * itself. The service client bypasses RLS entirely, so a single check would
 * be a single point of failure on the most powerful client in the system.
 */
export const dynamic = 'force-dynamic'

const requestSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('grant'),
    userId: z.uuid(),
    amount: z.number().int().min(1).max(1000),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    op: z.literal('reverse'),
    userId: z.uuid(),
    ledgerId: z.uuid(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    op: z.literal('cap'),
    userId: z.uuid(),
    cap: z.number().int().min(0).max(100000),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    op: z.literal('ceiling'),
    userId: z.uuid(),
    max: z.number().int().min(0).max(100000),
    note: z.string().trim().max(500).optional(),
  }),
])

export async function POST(request: Request): Promise<NextResponse> {
  const callerId = await requireUserId()
  const supabase = await memberClient()

  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle()

  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'That action is not allowed.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'That operation is not valid.' }, { status: 400 })
  }

  const service = createServiceClient()

  // Optional RPC args are assigned conditionally: `exactOptionalPropertyTypes`
  // rejects an explicit `undefined`, so "no note" means "key absent" — the
  // same convention the entries route uses for its optional RPC arguments.
  const withNote = (note: string | undefined): { p_note?: string } =>
    note === undefined ? {} : { p_note: note }

  switch (parsed.data.op) {
    case 'grant': {
      const { data: balance, error } = await service.rpc('admin_grant_credit', {
        p_user_id: parsed.data.userId,
        p_amount: parsed.data.amount,
        ...withNote(parsed.data.note),
      })
      if (error) return NextResponse.json({ error: 'That grant failed.' }, { status: 500 })
      return NextResponse.json({ ok: true, balance })
    }

    case 'reverse': {
      const { data: balance, error } = await service.rpc('admin_reverse_credit', {
        p_user_id: parsed.data.userId,
        p_ledger_id: parsed.data.ledgerId,
        ...withNote(parsed.data.note),
      })
      if (error) {
        return mapAdminError(error.message)
      }
      return NextResponse.json({ ok: true, balance })
    }

    case 'cap': {
      const { data: balance, error } = await service.rpc('admin_cap_credit', {
        p_user_id: parsed.data.userId,
        p_cap: parsed.data.cap,
        ...withNote(parsed.data.note),
      })
      if (error) return NextResponse.json({ error: 'That cap failed.' }, { status: 500 })
      return NextResponse.json({ ok: true, balance })
    }

    case 'ceiling': {
      // Future-only: no RPC exists because there is nothing to compute — the
      // row itself is both the control and its own audit trail.
      const { error } = await service.from('moderation_actions').insert({
        actor_id: callerId,
        action: 'credit_cap_set',
        target_type: 'user',
        target_id: parsed.data.userId,
        meta: { max: parsed.data.max, note: parsed.data.note ?? null },
      })
      if (error) return NextResponse.json({ error: 'That ceiling failed.' }, { status: 500 })
      return NextResponse.json({ ok: true, max: parsed.data.max })
    }

    default: {
      return NextResponse.json({ error: 'That operation is not valid.' }, { status: 400 })
    }
  }
}

function mapAdminError(message: string): NextResponse {
  if (message.includes('Ledger row not found')) {
    return NextResponse.json({ error: 'That ledger entry does not exist.' }, { status: 404 })
  }
  if (message.includes('Already reversed')) {
    return NextResponse.json({ error: 'That credit was already reversed.' }, { status: 409 })
  }
  return NextResponse.json({ error: 'That reversal failed.' }, { status: 500 })
}
