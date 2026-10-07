import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { currentUserId, memberClient } from '@/lib/server'
import { AdminSubNav } from './AdminSubNav'

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const userId = await currentUserId()
  if (!userId) {
    redirect('/feed')
  }

  const supabase = await memberClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (profile?.role !== 'admin') {
    redirect('/feed')
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="rounded bg-brand/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-brand uppercase">
            Internal Console
          </span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Admin Operations</h1>
        <p className="text-sm text-ink-muted">
          Platform moderation, community management, credit ledger audits, and system health metrics.
        </p>
      </header>

      <AdminSubNav />

      <div>{children}</div>
    </div>
  )
}
