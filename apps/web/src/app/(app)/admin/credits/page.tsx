import type { Metadata } from 'next'

import { createServiceClient } from '@fydio/supabase/service'

import { CreditOpsForm, type LedgerAuditRow } from './CreditOpsForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Credit Operations | Admin | Fydio',
}

interface PageProps {
  searchParams: Promise<{ userId?: string }>
}

export default async function AdminCreditsPage({ searchParams }: PageProps) {
  const { userId } = await searchParams
  const service = createServiceClient()

  const { data: rawLedger } = await service
    .from('credit_ledger')
    .select(`
      id,
      user_id,
      delta,
      kind,
      status,
      note,
      created_at,
      user:profiles!user_id(handle)
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  const recentLedger: LedgerAuditRow[] = (rawLedger ?? []).map((row) => {
    const userRaw = (Array.isArray(row.user) ? row.user[0] : row.user) as { handle?: unknown } | null
    const user_handle = typeof userRaw?.handle === 'string' ? userRaw.handle : undefined
    return {
      id: row.id,
      user_id: row.user_id,
      delta: row.delta,
      kind: row.kind,
      status: row.status,
      note: row.note,
      created_at: row.created_at,
      ...(user_handle ? { user_handle } : {}),
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Audited Credit Operations</h2>
        <p className="text-xs text-ink-muted">
          Execute audited credit operations: grants, single-row clawback reversals, balance caps,
          and future earning ceilings. Every action updates the ledger and records a permanent moderation action.
        </p>
      </div>

      <CreditOpsForm initialUserId={userId} recentLedger={recentLedger} />
    </div>
  )
}
