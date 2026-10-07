-- =============================================================================
-- T09 · 0029 — Feedback Storage & Success Metrics Views
-- =============================================================================
--
-- Provisions the `feedback-images` bucket with RLS policies and builds the
-- success-metrics dashboard views using exclusively Fydio-internal signals.
-- No external likes, views, followers, shares, or watch time are referenced.

-- =============================================================================
-- Storage: feedback-images bucket
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-images',
  'feedback-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "feedback images are publicly readable" on storage.objects;
create policy "feedback images are publicly readable"
  on storage.objects
  for select
  using (bucket_id = 'feedback-images');

drop policy if exists "members upload to own feedback folder" on storage.objects;
create policy "members upload to own feedback folder"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members update own feedback images" on storage.objects;
create policy "members update own feedback images"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members delete own feedback images" on storage.objects;
create policy "members delete own feedback images"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- =============================================================================
-- Metrics Views
-- =============================================================================

drop view if exists public.weekly_engagement_dashboard cascade;

create or replace view public.weekly_engagement_dashboard
with (security_invoker = true) as
with weeks as (
  select distinct date_trunc('week', d)::timestamptz as week_start
  from (
    select published_at as d from public.content_entries
    union
    select served_at as d from public.feed_impressions
    union
    select clicked_at as d from public.outbound_clicks
    union
    select created_at as d from public.feedback
    union
    select created_at as d from public.credit_ledger
  ) s
  where d is not null
),
entries_agg as (
  select
    date_trunc('week', published_at)::timestamptz as week_start,
    count(distinct id) as entries_published,
    count(distinct author_id) as active_creators
  from public.content_entries
  where status <> 'removed' and published_at is not null
  group by 1
),
impressions_agg as (
  select
    date_trunc('week', served_at)::timestamptz as week_start,
    count(*) as total_impressions,
    count(*) filter (where opened) as opened_impressions,
    count(distinct viewer_id) as impression_viewers
  from public.feed_impressions
  group by 1
),
clicks_agg as (
  select
    date_trunc('week', clicked_at)::timestamptz as week_start,
    count(*) as outbound_clicks_count,
    count(distinct (entry_id, user_id)) as opened_entry_pairs,
    count(distinct user_id) as click_viewers
  from public.outbound_clicks
  group by 1
),
feedback_agg as (
  select
    date_trunc('week', created_at)::timestamptz as week_start,
    count(*) filter (where removed_at is null) as feedback_items,
    count(distinct author_id) filter (where removed_at is null) as feedback_givers
  from public.feedback
  group by 1
),
ratings_agg as (
  select
    date_trunc('week', created_at)::timestamptz as week_start,
    count(*) as ratings_count,
    round(avg(score)::numeric, 2) as avg_rating_score
  from public.feedback_ratings
  group by 1
),
credits_agg as (
  select
    date_trunc('week', created_at)::timestamptz as week_start,
    coalesce(sum(delta) filter (where kind = 'feedback_earned' and status in ('held', 'available')), 0)::bigint as credits_earned_feedback,
    abs(coalesce(sum(delta) filter (where kind = 'submission_spend'), 0))::bigint as credits_spent_submissions
  from public.credit_ledger
  group by 1
),
weekly_active as (
  select
    w.week_start,
    count(distinct member_id) as weekly_active_members
  from weeks w
  left join (
    select date_trunc('week', served_at)::timestamptz as week_start, viewer_id as member_id from public.feed_impressions
    union
    select date_trunc('week', clicked_at)::timestamptz as week_start, user_id as member_id from public.outbound_clicks
  ) m on m.week_start = w.week_start
  group by w.week_start
),
fairness_agg as (
  select
    w.week_start,
    count(distinct e.author_id) as active_creators_pool,
    count(distinct e.author_id) filter (
      where exists (
        select 1 from public.feed_impressions fi
         where fi.entry_id = e.id and fi.opened
           and date_trunc('week', fi.served_at) = w.week_start
      ) or exists (
        select 1 from public.feedback fb
         where fb.entry_id = e.id and fb.removed_at is null
           and date_trunc('week', fb.created_at) = w.week_start
      )
    ) as creators_with_engagement
  from weeks w
  cross join public.content_entries e
  where e.status = 'active'
    and date_trunc('week', e.published_at) <= w.week_start
  group by w.week_start
)
select
  w.week_start,
  w.week_start as week,
  coalesce(wa.weekly_active_members, 0)::bigint as weekly_active_members,
  coalesce(ea.entries_published, 0)::bigint as entries_published,
  coalesce(ea.active_creators, 0)::bigint as active_creators,
  case when coalesce(ea.active_creators, 0) > 0
       then round(ea.entries_published::numeric / ea.active_creators, 2)
       else 0 end as submissions_per_active_creator,
  coalesce(ia.total_impressions, 0)::bigint as total_impressions,
  coalesce(ia.opened_impressions, 0)::bigint as opened_impressions,
  case when coalesce(ia.total_impressions, 0) > 0
       then round(ia.opened_impressions::numeric / ia.total_impressions * 100, 2)
       else 0 end as feed_open_rate_pct,
  coalesce(fa.feedback_items, 0)::bigint as feedback_items,
  coalesce(fa.feedback_givers, 0)::bigint as feedback_givers,
  case when coalesce(ca.opened_entry_pairs, 0) > 0
       then round(coalesce(fa.feedback_items, 0)::numeric / ca.opened_entry_pairs, 2)
       else 0 end as feedback_per_opened_entry,
  coalesce(cra.credits_earned_feedback, 0)::bigint as credits_earned_feedback,
  coalesce(cra.credits_spent_submissions, 0)::bigint as credits_spent_submissions,
  coalesce(ra.ratings_count, 0)::bigint as feedback_rated_count,
  case when coalesce(fa.feedback_items, 0) > 0
       then round(coalesce(ra.ratings_count, 0)::numeric / fa.feedback_items * 100, 2)
       else 0 end as feedback_rated_pct,
  coalesce(ra.avg_rating_score, 0)::numeric as avg_feedback_rating,
  case when coalesce(fa_fair.active_creators_pool, 0) > 0
       then round(coalesce(fa_fair.creators_with_engagement, 0)::numeric / fa_fair.active_creators_pool * 100, 2)
       else 0 end as distribution_fairness_pct
from weeks w
left join weekly_active wa on wa.week_start = w.week_start
left join entries_agg ea on ea.week_start = w.week_start
left join impressions_agg ia on ia.week_start = w.week_start
left join clicks_agg ca on ca.week_start = w.week_start
left join feedback_agg fa on fa.week_start = w.week_start
left join ratings_agg ra on ra.week_start = w.week_start
left join credits_agg cra on cra.week_start = w.week_start
left join fairness_agg fa_fair on fa_fair.week_start = w.week_start;

-- --- member_retention_cohorts ------------------------------------------------

drop view if exists public.member_retention_cohorts cascade;

create or replace view public.member_retention_cohorts
with (security_invoker = true) as
with cohorts as (
  select
    date_trunc('week', p.created_at)::timestamptz as cohort_week,
    p.id as user_id,
    p.created_at as joined_at
  from public.profiles p
),
activity as (
  select viewer_id as user_id, served_at as active_at from public.feed_impressions
  union
  select user_id, clicked_at as active_at from public.outbound_clicks
  union
  select author_id as user_id, created_at as active_at from public.feedback
)
select
  c.cohort_week,
  count(distinct c.user_id) as new_members,
  count(distinct c.user_id) filter (
    where exists (
      select 1 from activity a
       where a.user_id = c.user_id
         and a.active_at >= c.joined_at + interval '7 days'
         and a.active_at < c.joined_at + interval '14 days'
    )
  ) as retained_7d,
  case when count(distinct c.user_id) > 0
       then round(
         count(distinct c.user_id) filter (
           where exists (
             select 1 from activity a
              where a.user_id = c.user_id
                and a.active_at >= c.joined_at + interval '7 days'
                and a.active_at < c.joined_at + interval '14 days'
           )
         )::numeric / count(distinct c.user_id) * 100, 2
       )
       else 0 end as retention_7d_pct,
  count(distinct c.user_id) filter (
    where exists (
      select 1 from activity a
       where a.user_id = c.user_id
         and a.active_at >= c.joined_at + interval '28 days'
         and a.active_at < c.joined_at + interval '35 days'
    )
  ) as retained_28d,
  case when count(distinct c.user_id) > 0
       then round(
         count(distinct c.user_id) filter (
           where exists (
             select 1 from activity a
              where a.user_id = c.user_id
                and a.active_at >= c.joined_at + interval '28 days'
                and a.active_at < c.joined_at + interval '35 days'
           )
         )::numeric / count(distinct c.user_id) * 100, 2
       )
       else 0 end as retention_28d_pct
from cohorts c
group by c.cohort_week;

grant select on public.weekly_engagement_dashboard to authenticated;
grant select on public.member_retention_cohorts to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop view if exists public.member_retention_cohorts;
-- drop view if exists public.weekly_engagement_dashboard;
-- delete from storage.buckets where id = 'feedback-images';
