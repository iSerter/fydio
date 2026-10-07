import type { Metadata } from 'next'

import { createServiceClient } from '@fydio/supabase/service'

import { UsersTable, type AdminUserItem } from './UsersTable'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Members Management | Admin | Fydio',
}

export default async function AdminUsersPage() {
  const service = createServiceClient()

  const { data: profiles } = await service
    .from('profiles')
    .select('id, handle, display_name, role, created_at, reputation_avg, rated_feedback_count')
    .order('created_at', { ascending: false })
    .limit(100)

  const userIds = (profiles ?? []).map((p) => p.id)

  const creditMap = new Map<string, { available: number; held: number }>()
  if (userIds.length > 0) {
    const { data: ledgerRows } = await service
      .from('credit_ledger')
      .select('user_id, delta, status')
      .in('user_id', userIds)

    for (const row of ledgerRows ?? []) {
      const current = creditMap.get(row.user_id) ?? { available: 0, held: 0 }
      if (row.status === 'available' || row.status === 'spent') {
        current.available += row.delta
      } else if (row.status === 'held') {
        current.held += row.delta
      }
      creditMap.set(row.user_id, current)
    }
  }

  const initialUsers: AdminUserItem[] = (profiles ?? []).map((p) => {
    const balance = creditMap.get(p.id) ?? { available: 0, held: 0 }
    return {
      id: p.id,
      handle: p.handle,
      display_name: p.display_name,
      role: p.role,
      created_at: p.created_at,
      availableCredits: balance.available,
      heldCredits: balance.held,
      reputationAvg: p.reputation_avg,
      ratedCount: p.rated_feedback_count,
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Member Management</h2>
        <p className="text-xs text-ink-muted">
          Inspect member accounts, audit Credit balances, grant or revoke administrator roles, and initiate credit operations.
        </p>
      </div>

      <UsersTable initialUsers={initialUsers} />
    </div>
  )
}
