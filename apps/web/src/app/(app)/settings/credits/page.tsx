import type { Metadata } from 'next'

import { Badge, Stack } from '@fydio/ui'

import { parseCreditSummary, type CreditSummary } from '@fydio/domain'

import { CreditBalanceCard } from '@/components/credits/CreditBalanceCard'
import { CreditExplainer } from '@/components/credits/CreditExplainer'
import { CreditHistoryList } from '@/components/credits/CreditHistoryList'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = {
  title: 'Your Credits | Fydio',
}

/** Dynamic: reads the signed-in member's own credit summary. */
export const dynamic = 'force-dynamic'

/**
 * The private credits dashboard (T05).
 *
 * ONE member's summary, read through the privacy-enforcing RPC: no handle
 * parameter, no other-member view. A missing or malformed payload renders an
 * honest error rather than a zero — a zero would read as "you are broke"
 * when the truth is "the read failed".
 */
export default async function CreditsSettingsPage() {
  await requireUserId()
  const supabase = await memberClient()

  // No argument: `get_credit_summary` defaults to the caller, so there is no
  // user id in this call that could be pointed at someone else.
  const { data, error } = await supabase.rpc('get_credit_summary')

  const summary = error ? null : toSummary(data)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <Stack gap={2}>
        <Badge tone="brand">Settings</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Your Credits</h1>
        <p className="text-ink-muted">
          Credits buy submission access. Your balance is private — only you (and Fydio
          administrators for support) can see this page.
        </p>
      </Stack>

      {summary === null ? (
        <p role="alert" className="text-sm text-critical">
          Your credit summary could not be loaded. Try again in a moment.
        </p>
      ) : (
        <>
          <CreditBalanceCard summary={summary} />
          <CreditHistoryList history={summary.history} />
        </>
      )}

      <CreditExplainer />
    </main>
  )
}

/**
 * The RPC is ours, but a malformed payload must render as "could not load"
 * rather than as a balance — least surprise over cleverness.
 */
function toSummary(data: unknown): CreditSummary | null {
  try {
    return parseCreditSummary(data)
  } catch {
    return null
  }
}
