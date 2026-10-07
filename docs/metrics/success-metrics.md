# Fydio Success Metrics

This document defines the 10 core success metrics that measure platform health, peer-critique quality, and credit economy circulation within Fydio.

---

## 1. Core Philosophy & Signal Purity

Fydio's success metrics are derived **exclusively from internal peer-feedback signals**.

### Why External Platform Metrics Are Excluded
Platforms like YouTube, TikTok, Instagram, and X optimize for algorithmic watch time, viewer retention loops, and virality. Incorporating third-party view counts, likes, subscriber numbers, or external shares would:
1. **Import External Algorithmic Bias**: Favor creators with existing large followings elsewhere rather than members contributing thoughtful critiques here.
2. **Distort Feedback Incentives**: Encourage gaming feedback to chase views rather than offering actionable, constructive guidance.
3. **Compromise Member Privacy**: Require tracking off-platform browsing behavior.

In Fydio:
- **Credits** represent the right to share work for feedback (earned through eligible critiques, spent to post).
- **Reputation** represents private, peer-validated critique quality (rated 1–10 by the creator who received it).
- **Platform Health** is defined by authentic peer engagement, distribution fairness, and member retention.

---

## 2. The 10 Success Metrics

| # | Metric | Definition | SQL Expression / Source |
|---|--------|------------|-------------------------|
| 1 | **Weekly Active Members (WAM)** | Distinct members who actively engaged with the feed (viewed feed impressions or recorded outbound clicks) in a calendar week. | `count(distinct member_id)` from `feed_impressions` ∪ `outbound_clicks` |
| 2 | **Content Submissions per Active Creator** | Ratio of published entries to unique submitting authors during the week. | `count(distinct id) / count(distinct author_id)` from `content_entries` (`status <> 'removed'`) |
| 3 | **Feed Open Rate** | Percentage of feed impressions that resulted in an entry card being clicked/opened. | `count(*) filter (where opened) / count(*)` from `feed_impressions` |
| 4 | **Feedback per Opened Entry** | Average number of feedback critiques submitted per opened entry session. | `count(feedback) / count(distinct (entry_id, user_id))` from `outbound_clicks` |
| 5 | **Credits Earned through Feedback** | Total spendable Credits credited to members for writing quality-gated peer feedback. | `sum(delta)` from `credit_ledger` where `kind = 'feedback_earned'` and `status in ('held', 'available')` |
| 6 | **Credits Spent on Submissions** | Total spendable Credits deducted from creators to publish new content. | `abs(sum(delta))` from `credit_ledger` where `kind = 'submission_spend'` |
| 7 | **Percentage of Feedback Rated by Creators** | Share of submitted feedback critiques that received a 1–10 rating from the entry's creator. | `count(feedback_ratings) / count(feedback)` |
| 8 | **Average Rated Feedback Score** | Mean rating (on a 1–10 scale) given by creators to feedback received. | `round(avg(score)::numeric, 2)` from `feedback_ratings` |
| 9 | **7- and 28-Day Member Retention** | Percentage of new signups in a weekly cohort who return and engage (view, click, or critique) between 7–14 days and 28–35 days after joining. | Cohort join date against activity window in `member_retention_cohorts` |
| 10 | **Distribution Fairness** | Percentage of active creators with published entries who received at least one open or critique during the week. | Creators with ≥1 open or feedback / Total active pool in `weekly_engagement_dashboard` |

---

## 3. Database Architecture

The metrics are computed in real time using Postgres views in `supabase/migrations/0029_metrics_views.sql`:

### `public.weekly_engagement_dashboard`
Aggregates activity grouped by `date_trunc('week', timestamp)`:
- `weeks`: Unified timeline spanning published entries, feed impressions, outbound clicks, feedback submissions, and ledger movements.
- `weekly_active`: Deduplicated member engagement per week.
- `entries_agg`: Submission volumes and creator participation.
- `impressions_agg` & `clicks_agg`: Feed engagement and outbound clickthroughs.
- `feedback_agg` & `ratings_agg`: Feedback production and creator rating rates.
- `credits_agg`: Economy circulation (feedback earnings vs submission burns).
- `fairness_agg`: Proportion of active creators receiving attention, ensuring the feed does not concentrate visibility on a small subset of authors.

### `public.member_retention_cohorts`
Groups members by signup cohort (`cohort_week`) and evaluates subsequent activity timestamps:
- `retained_7d` / `retention_7d_pct`: Active between `[joined_at + 7 days, joined_at + 14 days)`.
- `retained_28d` / `retention_28d_pct`: Active between `[joined_at + 28 days, joined_at + 35 days)`.

Both views declare `security_invoker = true` and grant `SELECT` access to `authenticated` users, allowing the admin dashboard to query them directly without service-role escalation.

---

## 4. UI & Operational Surfaces

1. **Admin Console (`/admin/metrics`)**:
   - Executive snapshot cards displaying the latest week's internal signals.
   - Comprehensive weekly engagement table spanning up to 12 weeks.
   - Cohort retention breakdown (7d & 28d).

2. **Creator Dashboard (`/dashboard`)**:
   - Creator-specific performance: published entries, feedback received, creator rating completion rate, and feed open rate.

3. **Feedback Portfolio (`/dashboard/feedback`)**:
   - Member-specific feedback history, ratings received, and private Reputation metrics.
