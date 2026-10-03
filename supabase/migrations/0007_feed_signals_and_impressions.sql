-- =============================================================================
-- T02 · 0007 — Feed signals, impressions, mutes
-- =============================================================================
--
-- The inputs the curated feed ranks on (brief §4), and the "opened" history that
-- feedback eligibility depends on.
--
-- NOTE ON `rank_feed`: this is the deterministic stub T02 promises. It applies the
-- same formula as `scoreCandidate` in `@fydio/domain` — tag overlap, friend
-- affinity, freshness decay, feedback need — so the shape is correct and T07 can
-- fill in diversity adjustment and cursor pagination against a working baseline
-- rather than inventing the signature later. The weights come from the same
-- `FEED_*` tunables the TypeScript mirrors.

-- `position` is the slot the entry occupied in the feed, so it is meaningful for a
-- served impression and meaningless for a mark_entry_opened() upsert — hence
-- nullable, with a CHECK rather than a NOT NULL. The function below relies on this:
-- an open recorded outside a feed render has no slot to record.
create table public.feed_impressions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,

  position integer,
  score numeric(8,4),
  reason_code text,

  served_at timestamptz not null default now(),

  opened boolean not null default false,
  opened_at timestamptz,

  -- A recorded position is a real slot in the feed, so it starts at 1.
  constraint feed_impression_position_positive check (position is null or position >= 1),

  -- An open always has a timestamp, and an `opened_at` implies `opened`. Without this
  -- a row could claim to be open without saying when, which is the field the
  -- feedback-eligibility check reads.
  constraint feed_impression_open_consistent check (
    (opened = false and opened_at is null) or opened = true
  ),

  -- One row per (viewer, entry). The unique index makes "have I seen this" a
  -- lookup rather than a query, and makes the served row itself idempotent.
  unique (viewer_id, entry_id)
);

-- One impression per pair, so the open-history check in `submit_feedback` is an
-- index hit rather than a scan.
create unique index feed_impressions_viewer_entry_idx on public.feed_impressions (viewer_id, entry_id);
create index feed_impressions_entry_time_idx on public.feed_impressions (entry_id, served_at desc);

-- --- Feed tuning signals ---------------------------------------------------------
--
-- These affect ONLY Fydio's own recommendations. They are never sent anywhere and
-- never reward anyone — "more like this" is a ranking hint, not an endorsement.

create table public.feed_signals (
  id uuid primary key default gen_random_uuid(),
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  signal feed_signal_kind not null,
  created_at timestamptz not null default now(),

  -- One signal per pair: pressing "less like" twice is not twice the preference.
  unique (viewer_id, entry_id)
);

create index feed_signals_viewer_idx on public.feed_signals (viewer_id, created_at desc);

-- --- Mutes -----------------------------------------------------------------------
--
-- Muted creators are excluded from a viewer's feed. This is a personal preference,
-- not a block: it hides content without pretending the relationship ended.

create table public.mutes (
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  muted_profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (viewer_id, muted_profile_id),

  constraint mute_no_self check (viewer_id <> muted_profile_id)
);

create index mutes_viewer_idx on public.mutes (viewer_id);

-- --- mark_entry_opened ------------------------------------------------------------

create or replace function public.mark_entry_opened(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Upsert rather than insert: a member can open the same entry repeatedly (from a
  -- bookmark, a shared link, a second visit), and the first open is the only one
  -- that matters. `opened_at` keeps the FIRST timestamp via `coalesce`, so a later
  -- re-open does not overwrite when the connection was originally made.
  insert into public.feed_impressions (entry_id, viewer_id, opened, opened_at, served_at)
  values (p_entry_id, auth.uid(), true, now(), now())
  on conflict (viewer_id, entry_id) do update
    set opened = true,
        opened_at = coalesce(public.feed_impressions.opened_at, excluded.opened_at);
end;
$$;

-- --- submit_feed_signal -----------------------------------------------------------

create or replace function public.submit_feed_signal(p_entry_id uuid, p_signal text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- 'hide' removes the signal row entirely: a hidden item is an absence from the
  -- feed, not a stored negative preference that has to be re-applied forever.
  if p_signal = 'hide' then
    delete from public.feed_signals where viewer_id = auth.uid() and entry_id = p_entry_id;
    return;
  end if;

  if p_signal not in ('more_like', 'less_like') then
    raise exception 'Unknown feed signal: %', p_signal using errcode = 'check_violation';
  end if;

  insert into public.feed_signals (viewer_id, entry_id, signal)
  values (auth.uid(), p_entry_id, p_signal::feed_signal_kind)
  on conflict (viewer_id, entry_id) do update set signal = excluded.signal;
end;
$$;

-- --- mute_creator / unmute_creator --------------------------------------------------

create or replace function public.mute_creator(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_profile_id = auth.uid() then
    raise exception 'You cannot mute yourself' using errcode = 'check_violation';
  end if;

  insert into public.mutes (viewer_id, muted_profile_id)
  values (auth.uid(), p_profile_id)
  on conflict do nothing;
end;
$$;

create or replace function public.unmute_creator(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.mutes where viewer_id = auth.uid() and muted_profile_id = p_profile_id;
end;
$$;

-- --- rank_feed: the deterministic stub ------------------------------------------------
--
-- `relevance = tag_match + friend_affinity + feedback_need + freshness`
-- exactly as `scoreCandidate` computes it in @fydio/domain. Both implementations
-- are deliberately the same arithmetic so T07 can diff them rather than trust that
-- they agree.
--
-- An entry is always included unless muted, so a member with no hashtag overlap
-- still gets a feed — an empty feed would be a worse failure than a weak ranking.

create or replace function public.rank_feed(
  p_limit     integer default 20,
  p_cursor    timestamptz default null,
  p_platforms platform_kind[] default null
) returns table (
  rank        bigint,
  entry       jsonb,
  score       numeric,
  reason_code text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
  with viewer_tags as (
    select ph.hashtag_id
      from public.profile_hashtags ph
     where ph.profile_id = v_uid
  ),
  scored as (
    select
      e.id,
      -- Tag match: fraction of the VIEWER's tags the entry carries. Divided by
      -- the viewer's tag count, not the intersection, so a broad entry cannot beat
      -- a precise one by carrying more tags.
      coalesce((
        select count(*)::numeric
          from public.content_hashtags ch
         where ch.content_entry_id = e.id
           and ch.hashtag_id in (select hashtag_id from viewer_tags)
      ) / nullif((select count(*) from viewer_tags), 0), 0) * 1.0
      -- Friend affinity: a flat, transparent boost for confirmed friends.
      + case when exists (
          select 1 from public.friendships f
           where f.state = 'accepted'
             and ((f.requester_id = v_uid and f.addressee_id = e.author_id)
               or (f.addressee_id = v_uid and f.requester_id = e.author_id))
        ) then 0.35 else 0 end
      -- Feedback need: an entry nobody has responded to.
      + case when not exists (
          select 1 from public.feedback f where f.entry_id = e.id and f.removed_at is null
        ) then 0.15 else 0 end
      -- Freshness: exponential decay, 2^(-age/halfLife), clamped to [0,1] so a
      -- clock skew putting an entry slightly in the future cannot exceed 1.
      + least(1, greatest(0, power(2, -extract(epoch from (now() - e.published_at)) / 3600.0 / 36.0)))
      as s
    from public.content_entries e
   where e.status = 'active'
     and (p_platforms is null or e.platform = any (p_platforms))
     and (p_cursor is null or e.published_at < p_cursor)
     -- Muted creators are excluded from this viewer's feed.
     and not exists (
       select 1 from public.mutes m
        where m.viewer_id = v_uid and m.muted_profile_id = e.author_id
     )
     -- Never show a member their own work back at them as discovery.
     and e.author_id <> v_uid
  )
  select
    row_number() over (order by s.s desc, id),
    to_jsonb(e.*),
    s.s,
    -- "Transparent ranking" is a product principle, so every item carries a
    -- reason the UI can show rather than an opaque score.
    case
      when s.s >= 0.35 then 'friend'
      when exists (select 1 from public.content_hashtags ch
                    join viewer_tags vt on vt.hashtag_id = ch.hashtag_id
                   where ch.content_entry_id = e.id) then 'shared_hashtag'
      else 'fresh'
    end
  from scored s
  join public.content_entries e on e.id = s.id
  order by s.s desc, s.id
  limit greatest(1, least(coalesce(p_limit, 20), 50));
end;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.rank_feed(integer, timestamptz, platform_kind[]);
-- drop function if exists public.unmute_creator(uuid);
-- drop function if exists public.mute_creator(uuid);
-- drop function if exists public.submit_feed_signal(uuid, text);
-- drop function if exists public.mark_entry_opened(uuid);
-- drop table if exists public.mutes;
-- drop table if exists public.feed_signals;
-- drop table if exists public.feed_impressions;
