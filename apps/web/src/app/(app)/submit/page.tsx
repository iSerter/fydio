import type { Metadata } from 'next'

import { getServerEnv } from '@fydio/env/server'

import { SubmitForm } from '@/components/entry/SubmitForm'
import { memberClient, requireUserId } from '@/lib/server'

export const metadata: Metadata = { title: 'Submit | Fydio' }
export const dynamic = 'force-dynamic'

/**
 * Submission page (T04). Shows the current Credit balance and the cost of
 * submitting; the form itself lives in `SubmitForm`.
 */
export default async function SubmitPage() {
  const userId = await requireUserId()
  const supabase = await memberClient()

  const { data: balance } = await supabase.rpc('get_credit_balance', { p_user_id: userId })

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Share something you made</h1>
        <p className="mt-1 text-sm text-ink-muted">
          One Credit publishes one public link from Instagram, TikTok, YouTube, or X with exactly
          three hashtags. Previews resolve where the platform permits; otherwise a link card is
          shown.
        </p>
      </div>
      <SubmitForm
        creditBalance={typeof balance === 'number' ? balance : null}
        creditCost={getServerEnv().CREDIT_SUBMISSION_COST}
      />
    </main>
  )
}
