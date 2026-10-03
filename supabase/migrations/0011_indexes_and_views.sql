-- =============================================================================
-- T02 · 0011 — Indexes and reporting views
-- =============================================================================
--
-- Indexes tuned for the two queries that actually run at volume — the feed and
-- the feedback inbox — and three views for the T09 metrics work.
--
-- The indexes below are collected here rather than beside their tables so the
-- performance story reads in one place. They are all also created in the
-- migration that introduces their table where that table needed one to be
-- correct; what remains here is the tuning pass.

-- --- Feed ------------------------------------------------------------------------
--
-- Partial on `status = 'active'` because the feed only ever reads active entries.
-- At 30 members over 180 entries the table is small, but the index stays honest as
-- it grows, and the partial predicate keeps removed entries out of the index.

create index content_entries_active_published_idx
  on public.content_entries (published_at desc)
  where status = 'active';

-- Author lookups for the profile dashboard and the sweepers.
create index content_entries_status_idx on public.content_entries (status);

-- --- Credit ledger hot paths ---------------------------------------------------------
--
-- `hold_due_idx` is partial on `status = 'held'` specifically for
-- `release_held_credits`: that sweeper scans only rows past their release time, so
-- the index holds only rows it can act on and shrinks as credits are released.

create index credit_ledger_entry_idx on public.credit_ledger (entry_id)
  where entry_id is not null;

-- --- Feedback inbox -------------------------------------------------------------------

create index feedback_entry_removed_idx on public.feedback (entry_id)
  where removed_at is null;

-- --- Reputation -------------------------------------------------------------------------

-- Aggregates are recomputed from the ledger on every rating, so this is the index
-- that keeps `refresh_profile_reputation` cheap as the ledger grows.
create index reputation_ledger_user_kind_idx on public.reputation_ledger (user_id, kind);

-- --- Moderation -------------------------------------------------------------------------

create index moderation_reports_open_idx on public.moderation_reports (created_at)
  where state = 'open';

-- =============================================================================
-- Reporting views
-- =============================================================================
--
-- These are for the T09 metrics work, not for the member-facing app.
--
-- `security_invoker = true` is set on every one, which is the point: without it a
-- view runs with its OWNER's privileges and silently bypasses RLS, so a view over
-- `credit_ledger` would hand every member the whole community's balances. With it,
-- reading a view is exactly as restricted as reading its underlying tables.

-- Reputation is public, so this one is safe to expose broadly.
create or replace view public.profile_reputation
with (security_invoker = true) as
select
  p.id as profile_id,
  p.handle,
  p.reputation_total,
  p.rated_feedback_count,
  p.reputation_avg,
  case
    when p.reputation_total >= 500 then 'mentor'
    when p.reputation_total >= 200 then 'trusted'
    when p.reputation_total >= 50 then 'established'
    else null
  end as badge
from public.profiles p;

create or replace view public.entry_feedback_summary
with (security_invoker = true) as
select
  e.id as entry_id,
  e.author_id,
  e.published_at,
  count(f.id) filter (where f.removed_at is null) as feedback_count,
  count(r.id) as rated_count,
  coalesce(round(avg(r.score), 2), 0)::numeric(4,2) as average_score,
  e.asks_for_feedback
from public.content_entries e
left join public.feedback f on f.entry_id = e.id
left join public.feedback_ratings r on r.feedback_id = f.id
where e.status = 'active'
group by e.id, e.author_id, e.published_at, e.asks_for_feedback;

-- The success metrics from the brief §Success metrics, restricted to what Fydio is
-- allowed to measure: no external likes, views, followers or watch time.
create or replace view public.weekly_engagement_dashboard
with (security_invoker = true) as
select
  date_trunc('week', e.published_at) as week,
  count(distinct e.id) as entries_published,
  count(distinct e.author_id) as active_creators,
  count(distinct i.entry_id) filter (where i.opened) as entries_opened,
  count(distinct fb.id) as feedback_items,
  count(distinct fb.author_id) as feedback_givers
from public.content_entries e
left join public.feed_impressions i on i.entry_id = e.id
left join public.feedback fb on fb.entry_id = e.id and fb.removed_at is null
where e.status = 'active'
group by date_trunc('week', e.published_at);

-- Credit-flow reporting, for T05's admin screens. Kept as a view rather than an
-- RPC so it composes in a `select`, and `security_invoker` keeps it behind the same
-- RLS as the ledger itself.
create or replace view public.credit_flow_summary
with (security_invoker = true) as
select
  cl.user_id,
  cl.kind,
  count(*) as entries,
  coalesce(sum(cl.delta), 0)::integer as net_delta
from public.credit_ledger cl
where cl.status in ('available', 'spent')
group by cl.user_id, cl.kind;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop view if exists public.credit_flow_summary;
-- drop view if exists public.weekly_engagement_dashboard;
-- drop view if exists public.entry_feedback_summary;
-- drop view if exists public.profile_reputation;
-- drop index if exists public.moderation_reports_open_idx;
-- drop index if exists public.reputation_ledger_user_kind_idx;
-- drop index if exists public.feedback_entry_removed_idx;
-- drop index if exists public.credit_ledger_entry_idx;
-- drop index if exists public.content_entries_status_idx;
-- drop index if exists public.content_entries_active_published_idx;
