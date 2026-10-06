-- =============================================================================
-- T06 · 0017 — Reputation aggregates, badge tiers, rating summary
-- =============================================================================
--
-- T02 (0006) created the ledger, `rate_feedback`, `revise_rating`,
-- `refresh_profile_reputation` and `get_reputation`. This migration finishes
-- the T06 read model without touching the write path:
--
--   1. Badge tiers become operator-tunable via the
--      `app.reputation_badge_thresholds` GUC (JSON), defaulting to the T06
--      spec: contributor 25, trusted 100, mentor 250, else new.
--   2. `get_reputation` returns the spec shape
--      {total, ratedCount, average, badge} so the profile card and the domain
--      parser agree on field names.
--   3. New `get_rating_summary` returns the same aggregate plus the 10 most
--      recent rated feedback rows, which is what the public "rated feedback"
--      display on profiles renders. Rating input UI lands in T09; this is the
--      read-only surface T06 promises.
--
-- `refresh_profile_reputation` is intentionally untouched: it already recomputes
-- from the ledger (total) and from `feedback_ratings` (count/avg), so moderation
-- reversals move the total without dragging the average toward zero.

-- --- Badge helper --------------------------------------------------------------
--
-- Reads `app.reputation_badge_thresholds` as JSON
-- (e.g. '{"contributor":25,"trusted":100,"mentor":250}'). A missing, empty, or
-- malformed value falls back to the T06 defaults rather than failing the
-- profile query — a badge must never 500 a profile card.

create or replace function public.reputation_badge_for_total(p_total integer)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_raw text := current_setting('app.reputation_badge_thresholds', true);
  v_cfg jsonb;
  v_contributor integer := 25;
  v_trusted integer := 100;
  v_mentor integer := 250;
begin
  if v_raw is not null and btrim(v_raw) <> '' then
    begin
      v_cfg := v_raw::jsonb;
      v_contributor := coalesce(nullif((v_cfg ->> 'contributor'), '')::integer, v_contributor);
      v_trusted := coalesce(nullif((v_cfg ->> 'trusted'), '')::integer, v_trusted);
      v_mentor := coalesce(nullif((v_cfg ->> 'mentor'), '')::integer, v_mentor);
    exception when others then
      -- Malformed operator config: keep the defaults.
      v_contributor := 25;
      v_trusted := 100;
      v_mentor := 250;
    end;
  end if;

  if p_total >= v_mentor then
    return 'mentor';
  elsif p_total >= v_trusted then
    return 'trusted';
  elsif p_total >= v_contributor then
    return 'contributor';
  else
    return 'new';
  end if;
end;
$$;

-- --- get_reputation(): the spec shape ------------------------------------------
--
-- Public read model. RLS already allows every member to read `profiles` and
-- `reputation_ledger`; SECURITY DEFINER keeps the aggregate consistent for all
-- callers and lets the badge logic live in exactly one place.

create or replace function public.get_reputation(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'total', p.reputation_total,
    'ratedCount', p.rated_feedback_count,
    'average', p.reputation_avg,
    'badge', public.reputation_badge_for_total(p.reputation_total)
  )
  from public.profiles p
  where p.id = p_user_id;
$$;

-- --- get_rating_summary(): aggregate + recent rated feedback --------------------
--
-- What the public profile renders: the same numbers as `get_reputation` plus
-- the 10 most recent ratings the member RECEIVED (score, entry, timestamps).
-- Read-only; the only writer of reputation remains `rate_feedback` /
-- `revise_rating` / `reverse_reputation_for_feedback`.

create or replace function public.get_rating_summary(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rep jsonb;
  v_recent jsonb;
begin
  select public.get_reputation(p_user_id) into v_rep;

  if v_rep is null then
    raise exception 'Profile not found' using errcode = 'no_data_found';
  end if;

  select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb)
    into v_recent
    from (
      select r.feedback_id, f.entry_id, r.score, r.created_at, r.revised_at
        from public.feedback_ratings r
        join public.feedback f on f.id = r.feedback_id
       where f.author_id = p_user_id
       order by r.created_at desc
       limit 10
    ) t;

  return v_rep || jsonb_build_object('recent', v_recent);
end;
$$;

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Public read models: every signed-in member may call them (reputation is public
-- by product decision; credits are the private half). Same discipline as 0009:
-- revoke the image-default grants first, then grant explicitly.

revoke execute on function public.reputation_badge_for_total(integer) from public;
revoke execute on function public.reputation_badge_for_total(integer) from anon;
revoke execute on function public.get_reputation(uuid) from public;
revoke execute on function public.get_reputation(uuid) from anon;
revoke execute on function public.get_rating_summary(uuid) from public;
revoke execute on function public.get_rating_summary(uuid) from anon;

grant execute on function public.get_reputation(uuid) to authenticated;
grant execute on function public.get_rating_summary(uuid) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.get_rating_summary(uuid);
-- drop function if exists public.reputation_badge_for_total(integer);
-- (get_reputation reverts to its 0006 body on a down-migration.)
