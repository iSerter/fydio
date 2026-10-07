import type { Metadata } from 'next'
import { Card, Stack } from '@fydio/ui'

import { memberClient } from '@/lib/server'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Success Metrics | Admin | Fydio',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default async function AdminMetricsPage() {
  const supabase = await memberClient()

  const [weeklyRes, cohortsRes] = await Promise.all([
    supabase
      .from('weekly_engagement_dashboard')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(12),
    supabase
      .from('member_retention_cohorts')
      .select('*')
      .order('cohort_week', { ascending: false })
      .limit(12),
  ])

  const weeklyData = weeklyRes.data ?? []
  const cohortsData = cohortsRes.data ?? []

  const latest = weeklyData[0] ?? null

  return (
    <div className="flex flex-col gap-8">
      {/* Banner on internal-only signal purity */}
      <div className="rounded-control border border-border bg-surface-muted/50 p-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-brand">
            Fydio-Internal Signals Only
          </span>
          <span className="text-[11px] text-ink-subtle">
            Updated continuously via database views
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Every metric below measures authentic peer-feedback velocity, circulation of Credits,
          and member retention within Fydio. External platform vanity metrics (such as third-party views,
          likes, subscriber counts, and watch time) are deliberately excluded.
        </p>
      </div>

      {/* Primary KPI Cards */}
      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink uppercase">
          Latest Week Snapshot
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Weekly Active Members
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.weekly_active_members ?? 0}
              </span>
              <span className="text-[11px] text-ink-muted">Feed viewers + outbound clicks</span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Feed Open Rate
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.feed_open_rate_pct ? `${latest.feed_open_rate_pct}%` : '—'}
              </span>
              <span className="text-[11px] text-ink-muted">
                {latest?.opened_impressions ?? 0} opens / {latest?.total_impressions ?? 0} impressions
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Feedback Per Opened Entry
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.feedback_per_opened_entry ?? 0}
              </span>
              <span className="text-[11px] text-ink-muted">
                {latest?.feedback_items ?? 0} feedback items written
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Distribution Fairness
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.distribution_fairness_pct ? `${latest.distribution_fairness_pct}%` : '—'}
              </span>
              <span className="text-[11px] text-ink-muted">
                Active creators receiving ≥ 1 open or critique
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Feedback Rated Rate
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.feedback_rated_pct ? `${latest.feedback_rated_pct}%` : '—'}
              </span>
              <span className="text-[11px] text-ink-muted">
                {latest?.feedback_rated_count ?? 0} of {latest?.feedback_items ?? 0} rated
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Avg Feedback Rating
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.avg_feedback_rating ? `${latest.avg_feedback_rating}/10` : '—'}
              </span>
              <span className="text-[11px] text-ink-muted">Creator ratings on critiques</span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Submissions / Creator
              </span>
              <span className="text-3xl font-bold text-ink">
                {latest?.submissions_per_active_creator ?? 0}
              </span>
              <span className="text-[11px] text-ink-muted">
                {latest?.entries_published ?? 0} entries / {latest?.active_creators ?? 0} creators
              </span>
            </Stack>
          </Card>

          <Card>
            <Stack gap={1}>
              <span className="text-xs font-medium text-ink-subtle uppercase tracking-wider">
                Credits Circulation
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-ink">
                  +{latest?.credits_earned_feedback ?? 0}
                </span>
                <span className="text-sm font-semibold text-ink-subtle">
                  / -{latest?.credits_spent_submissions ?? 0}
                </span>
              </div>
              <span className="text-[11px] text-ink-muted">Earned via feedback / spent to submit</span>
            </Stack>
          </Card>
        </div>
      </section>

      {/* Weekly Engagement History Table */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink uppercase">
          Weekly Engagement History
        </h2>
        <div className="overflow-x-auto rounded-control border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Week</th>
                <th className="px-3 py-3 font-semibold text-right">Active</th>
                <th className="px-3 py-3 font-semibold text-right">Published</th>
                <th className="px-3 py-3 font-semibold text-right">Creators</th>
                <th className="px-3 py-3 font-semibold text-right">Open Rate</th>
                <th className="px-3 py-3 font-semibold text-right">Critiques</th>
                <th className="px-3 py-3 font-semibold text-right">Per Open</th>
                <th className="px-3 py-3 font-semibold text-right">% Rated</th>
                <th className="px-3 py-3 font-semibold text-right">Avg Score</th>
                <th className="px-3 py-3 font-semibold text-right">Fairness</th>
                <th className="px-3 py-3 font-semibold text-right">Credits Earned</th>
                <th className="px-4 py-3 font-semibold text-right">Credits Spent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {weeklyData.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-4 py-8 text-center text-ink-muted">
                    No weekly engagement records recorded yet.
                  </td>
                </tr>
              ) : (
                weeklyData.map((row) => (
                  <tr key={row.week_start ?? ''} className="hover:bg-surface-muted/30">
                    <td className="px-4 py-2.5 font-medium text-ink whitespace-nowrap">
                      {formatDate(row.week_start)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.weekly_active_members ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.entries_published ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.active_creators ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.feed_open_rate_pct != null ? `${row.feed_open_rate_pct}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.feedback_items ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.feedback_per_opened_entry ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.feedback_rated_pct != null ? `${row.feedback_rated_pct}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.avg_feedback_rating != null ? `${row.avg_feedback_rating}` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {row.distribution_fairness_pct != null
                        ? `${row.distribution_fairness_pct}%`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium text-brand">
                      +{row.credits_earned_feedback ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-ink-subtle">
                      -{row.credits_spent_submissions ?? 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Member Retention Cohorts Table */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-ink uppercase">
          Member Retention Cohorts (7d & 28d)
        </h2>
        <div className="overflow-x-auto rounded-control border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Cohort Week</th>
                <th className="px-3 py-3 font-semibold text-right">New Members</th>
                <th className="px-3 py-3 font-semibold text-right">7-Day Retained</th>
                <th className="px-3 py-3 font-semibold text-right">7-Day %</th>
                <th className="px-3 py-3 font-semibold text-right">28-Day Retained</th>
                <th className="px-4 py-3 font-semibold text-right">28-Day %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cohortsData.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                    No retention cohort data recorded yet.
                  </td>
                </tr>
              ) : (
                cohortsData.map((cohort) => (
                  <tr key={cohort.cohort_week ?? ''} className="hover:bg-surface-muted/30">
                    <td className="px-4 py-2.5 font-medium text-ink whitespace-nowrap">
                      {formatDate(cohort.cohort_week)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {cohort.new_members ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {cohort.retained_7d ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium text-brand">
                      {cohort.retention_7d_pct != null ? `${cohort.retention_7d_pct}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-ink">
                      {cohort.retained_28d ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-brand">
                      {cohort.retention_28d_pct != null ? `${cohort.retention_28d_pct}%` : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
