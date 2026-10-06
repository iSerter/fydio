-- =============================================================================
-- T07 · 0022 — Ranking transparency and diagnostics
-- =============================================================================
--
-- `ranked_reason` itself lives in 0020, immediately before `rank_feed` calls it,
-- because a function cannot depend on something a LATER migration creates. What is
-- left for the transparency story lives here.
--
-- THE REASON VOCABULARY IS NOT A POSTGRES ENUM, DELIBERATELY.
--
-- `feed_impressions.reason_code` is `text` (0007), and `@fydio/domain` exports
-- `FEED_REASONS` as a TypeScript union. Adding a third definition here as an enum
-- type would create a third thing to keep in step, and the one that matters least —
-- nothing in the database branches on the value except this file.
--
-- Instead the vocabulary is a CHECK constraint, which enforces the same thing at the
-- storage layer without inventing a type that already exists twice in another form.
-- `009_feed_ranking.sql` asserts the constraint accepts exactly the four codes in
-- `FEED_REASONS` and rejects a fifth, which is what keeps the two definitions from
-- drifting apart silently.

alter table public.feed_impressions
  drop constraint if exists feed_impressions_reason_code_known;

alter table public.feed_impressions
  add constraint feed_impressions_reason_code_known
  check (
    reason_code is null
    or reason_code in ('shared_hashtag', 'friend', 'fresh', 'new_creator')
  );

-- The member-facing label, in the database.
--
-- "Transparent ranking" is a promise about what the member is told, and what the
-- member is told is decided by the ranking, not by the rendering. Keeping the string
-- here means it can be asserted in SQL — a pgTAP test can prove every code the
-- ranker can emit resolves to a real sentence — rather than existing only in a
-- client bundle where a wrong string is invisible until someone sees it on screen.
--
-- Mirrors `FEED_REASON_LABELS` in `@fydio/domain`; both are covered by
-- `apps/web/test/ranking.regression.test.ts`, which fails if the two disagree.
create or replace function public.feed_reason_label(p_reason text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_reason
    when 'shared_hashtag' then 'Matches your hashtags'
    when 'friend'        then 'From someone you''re connected to'
    when 'fresh'         then 'Recently shared'
    when 'new_creator'   then 'No feedback yet'
    else 'Recently shared'
  end;
$$;

comment on function public.feed_reason_label(text) is
  'Member-facing reason text. Mirrors FEED_REASON_LABELS in @fydio/domain.';

-- --- entry_ranking_signals ---------------------------------------------------------------
--
-- The per-entry signal breakdown behind the ranking, for the "why this appeared"
-- affordance and for the T09 metrics work.
--
-- The matched-hashtag count is deliberately viewer-AGNOSTIC here: it counts every
-- member's profile hashtag that this entry carries, which is a property of the entry
-- rather than of any viewer. Per-viewer overlap is computed inside `rank_feed`,
-- which knows who is asking. A view that tried to answer "why did THIS member see
-- this" would have to be per-viewer and could not be a view at all.
--
-- `security_invoker = true` is the point. Without it a view runs with its OWNER's
-- privileges and silently bypasses RLS, so a view over `feed_signals` would hand
-- every member every member's tuning choices — which is exactly the kind of leak
-- 0009 exists to prevent. With it, reading this view is exactly as restricted as
-- reading the underlying tables directly.

create or replace view public.entry_ranking_signals
with (security_invoker = true) as
select
  ce.id as entry_id,
  ce.author_id,
  ce.platform,
  ce.published_at,
  ce.asks_for_feedback,

  (select count(*)
     from public.content_hashtags ch
    where ch.content_entry_id = ce.id) as hashtag_count,

  (select count(*)
     from public.content_hashtags ch
     join public.profile_hashtags ph on ph.hashtag_id = ch.hashtag_id
    where ch.content_entry_id = ce.id) as matched_profile_hashtags,

  (select count(*)
     from public.feedback f
    where f.entry_id = ce.id and f.removed_at is null) as feedback_count,

  (select count(*)
     from public.feed_signals fs
    where fs.entry_id = ce.id and fs.signal = 'hide') as hide_signals,

  (select count(*)
     from public.feed_signals fs
    where fs.entry_id = ce.id and fs.signal = 'less_like') as less_like_signals,

  (select count(*)
     from public.feed_signals fs
    where fs.entry_id = ce.id and fs.signal = 'more_like') as more_like_signals
from public.content_entries ce
where ce.status = 'active';

-- --- feed_impression_reasons ---------------------------------------------------------------
--
-- What the member was actually told, and how often, grouped by the entry they were
-- told it about. This is the artifact that makes "transparent ranking" checkable
-- after the fact: if the ranker starts labelling entries `friend` that nobody is
-- friends with, it shows up here.
--
-- A view rather than a table: the labels are derived and must not be able to go
-- stale independently of `feed_reason_label`.

create or replace view public.feed_impression_reasons
with (security_invoker = true) as
select
  i.reason_code,
  public.feed_reason_label(i.reason_code) as reason_label,
  count(*) as impressions,
  count(*) filter (where i.opened) as opened,
  count(distinct i.entry_id) as distinct_entries,
  count(distinct i.viewer_id) as distinct_viewers
from public.feed_impressions i
where i.reason_code is not null
group by i.reason_code;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop view if exists public.feed_impression_reasons;
-- drop view if exists public.entry_ranking_signals;
-- drop function if exists public.feed_reason_label(text);
-- alter table public.feed_impressions
--   drop constraint if exists feed_impressions_reason_code_known;