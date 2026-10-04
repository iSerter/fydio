-- =============================================================================
-- T05 · 0015 — Credit summary, hardened sweeper, cap ceiling
-- =============================================================================
--
-- Turns the T02 ledger into a readable economy without changing its accounting.
-- Nothing here alters the balance formula from 0004:
--
--   balance = sum(delta) WHERE status IN ('available', 'spent')
--
-- Held credits contribute nothing until the sweeper releases them; reversed rows
-- contribute nothing ever. The T05 task text proposed `available + held`, which
-- would let a submission spend go uncounted — see the header of 0004 for why
-- that formula silently makes submissions free. `get_credit_summary` below
-- reports `held` as a separate informational figure for exactly that reason.
--
-- This migration:
--   1. `get_credit_summary()` — private (self-or-admin) balance + history RPC.
--   2. Hardens `release_held_credits()` — never releases a credit whose
--      feedback was reported or removed, and flips due `held` feedback rows.
--   3. Adds `credit_cap_ceiling()` + enforces it in
--      `evaluate_feedback_eligibility()` — a ceiling blocks FUTURE earning, it
--      never rewrites history (that is what 0010's clawback is for).
--   4. Fixes the allowance GUC key (`credit_weekly_starter_allowance` missed its
--      `app.` prefix; the fallback default masked it).
--
-- WHY THE CEILING BLOCKS EARNING BUT NOT SPENDING. A submission REDUCES the
-- balance, so refusing to spend while above a cap would trap the member there
-- forever: earning is blocked (this migration) and spending is blocked
-- (hypothetically), with no path back under the cap. Spending down is the
-- escape hatch, so the ceiling is enforced on the earning path only.

-- --- 4. Allowance GUC key fix ---------------------------------------------------
--
-- Identical body to 0004 except `app_setting_int` now reads the documented key.
-- Behaviour is unchanged when the GUC is set (connection default wins either
-- way) and unchanged when it is absent (both fall back to 3); what changes is
-- that an operator-set `CREDIT_WEEKLY_STARTER_ALLOWANCE` is honoured here the
-- same way it is everywhere else.

create or replace function public.grant_weekly_allowance(p_amount integer default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('week', now() at time zone 'utc')::date;
  v_amount integer := coalesce(p_amount, public.app_setting_int('app.credit_weekly_starter_allowance', 3));
  v_granted integer;
begin
  -- Inserting the run row first is what makes the whole function idempotent: if
  -- this period has already been processed, the insert conflicts, we take the
  -- early exit, and nothing is granted twice.
  insert into public.weekly_allowance_runs (period_start, amount)
  values (v_period, v_amount)
  on conflict (period_start) do nothing;

  if not found then
    select granted_count into v_granted
      from public.weekly_allowance_runs
     where period_start = v_period;
    return 0;
  end if;

  insert into public.credit_ledger (user_id, delta, kind, status, note)
  select id, v_amount, 'weekly_allowance', 'available',
         'Weekly starter allowance for ' || v_period
    from public.profiles;

  update public.weekly_allowance_runs
     set granted_count = (select count(*) from public.profiles),
         ran_at = now()
   where period_start = v_period;

  return (select count(*) from public.profiles);
end;
$$;

-- --- 3. The cap ceiling ---------------------------------------------------------
--
-- A ceiling is a moderation decision recorded in `moderation_actions`, not a
-- column: columns get edited, audit rows do not. Both spellings are honoured
-- because 0010 wrote `credit_cap`/`cap` while the T05 text proposed
-- `credit_cap_set`/`max` — a cap set by either path must be visible to the
-- enforcement below, or one admin tool silently bypasses the other.
--
-- Returns NULL when no cap was ever set, so callers treat "no cap" as "no
-- constraint" without a second query.

create or replace function public.credit_cap_ceiling(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cap integer;
begin
  select coalesce((meta->>'cap')::integer, (meta->>'max')::integer)
    into v_cap
    from public.moderation_actions
   where target_type = 'user'
     and target_id = p_user_id::text
     and action in ('credit_cap', 'credit_cap_set')
   order by created_at desc
   limit 1;

  return v_cap;
end;
$$;

-- --- 1. get_credit_summary(): the private dashboard RPC --------------------------
--
-- One call returns everything the credits page needs: the spendable figure, the
-- pending-review figure, the cost of publishing, and the audit trail. Two
-- queries would race (a release between them shows a credit twice); one
-- function cannot.
--
-- SECURITY DEFINER for the same reason as `get_credit_balance`: RLS gives a
-- member no way to read another member's rows, so the function is also the
-- thing that authorises the read — self, or admin. The caller check uses
-- `is_admin()` on the CALLER, not the target: checking the target's role would
-- let anyone read an admin's balance, which is the opposite of private.

create or replace function public.get_credit_summary(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := coalesce(p_user_id, auth.uid());
  v_avail integer;
  v_held  integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if v_uid <> auth.uid() and not public.is_admin() then
    raise exception 'Credit balance is private' using errcode = 'insufficient_privilege';
  end if;

  -- The 0004 formula: spends are negative `spent` rows that MUST be summed, or
  -- the balance never falls. Held rows are counted separately below.
  select coalesce(sum(delta), 0)::integer
    into v_avail
    from public.credit_ledger
   where user_id = v_uid
     and status in ('available', 'spent');

  select coalesce(sum(delta), 0)::integer
    into v_held
    from public.credit_ledger
   where user_id = v_uid
     and status = 'held';

  return jsonb_build_object(
    'available',      v_avail,
    'held',           v_held,
    'total',          v_avail + v_held,
    'submissionCost', public.app_setting_int('app.credit_submission_cost', 1),
    'history', coalesce((
      select jsonb_agg(row_to_json(h) order by h.created_at desc)
      from (
        select cl.created_at, cl.delta, cl.kind::text as kind,
               cl.status::text as status, cl.note,
               ce.canonical_url as entry_url, cl.feedback_id
        from public.credit_ledger cl
        left join public.content_entries ce on ce.id = cl.entry_id
        where cl.user_id = v_uid
        order by cl.created_at desc
        limit 50
      ) h
    ), '[]'::jsonb)
  );
end;
$$;

-- --- 2. Hardened release_held_credits() -------------------------------------------
--
-- The 0004 sweeper released anything past its `available_at`. That is correct
-- for uncontested credits but wrong for contested ones: feedback reported AFTER
-- earning but BEFORE release would still pay out, and `evaluate_feedback_eligibility`
-- only guards at earn time. The two `not exists` clauses close that window —
-- a reported or removed feedback item's credit stays `held` until
-- `reverse_credit_for_feedback` (0016) clears it.
--
-- `target_id` is text while `feedback.id` is uuid, so the comparison stays in
-- text (`cl.feedback_id::text`) rather than casting the column: a non-uuid
-- `target_id` on another target type would make `target_id::uuid` raise and
-- abort the whole sweep instead of skipping one row.
--
-- `for update skip locked` is kept: two overlapping sweeps must not fight over
-- the same rows.

create or replace function public.release_held_credits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  with due as (
    select cl.id
      from public.credit_ledger cl
     where cl.status = 'held'
       and cl.available_at <= now()
       and (
         cl.feedback_id is null
         or not exists (
           select 1 from public.feedback fb
            where fb.id = cl.feedback_id
              and (fb.removed_at is not null or fb.eligibility = 'reversed')
         )
       )
       and (
         cl.feedback_id is null
         or not exists (
           select 1 from public.moderation_reports mr
            where mr.target_type = 'feedback'
              and mr.target_id = cl.feedback_id::text
              and mr.state <> 'dismissed'
         )
       )
     for update skip locked
  )
  update public.credit_ledger cl
     set status = 'available'
   where cl.id in (select id from due);

  get diagnostics v_released = row_count;

  -- `held` feedback rows are forward-compat: 0006 marks eligible feedback
  -- `eligible` with a `hold_until`, but the enum reserves `held` and the T05
  -- text expects the sweeper to clear it. If no such rows exist this is a no-op.
  update public.feedback
     set eligibility = 'eligible'
   where eligibility = 'held'
     and hold_until <= now();

  return v_released;
end;
$$;

-- --- 3b. Ceiling enforcement in evaluate_feedback_eligibility ----------------------
--
-- Full body from 0006 plus one block: when a ceiling exists and the spendable
-- balance already meets it, the feedback is `ineligible` with reason
-- `cap_reached` — the same shape as the daily and per-creator caps, so the UI
-- and the audit trail treat all three uniformly. The original rows are never
-- touched: a cap limits the future, it does not rewrite the past.

create or replace function public.evaluate_feedback_eligibility(p_feedback_id uuid)
returns eligibility_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fb     public.feedback;
  v_day    integer := public.app_setting_int('app.credit_per_day_cap', 5);
  v_crea   integer := public.app_setting_int('app.credit_per_creator_cap', 2);
  v_hold   integer := public.app_setting_int('app.credit_hold_hours', 48);
  v_amt    integer := public.app_setting_int('app.feedback_credit_amount', 1);
  v_seen   integer;
  v_by_own integer;
  v_cap    integer;
  v_bal    integer;
begin
  select * into v_fb from public.feedback where id = p_feedback_id for update;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  if v_fb.eligibility <> 'pending' then
    return v_fb.eligibility;   -- idempotent
  end if;

  -- Reported or removed => never eligible.
  if v_fb.removed_at is not null
     or exists (
       select 1 from public.moderation_reports
        where target_type = 'feedback' and target_id = v_fb.id::text
          and state <> 'dismissed'
     ) then
    update public.feedback set eligibility = 'reversed' where id = v_fb.id;
    return 'reversed';
  end if;

  -- Per-day cap. Counts held as well as available: a credit still inside its
  -- review window has already consumed the day's earning budget, and the caps
  -- exist to bound how fast someone can farm, not how much they can bank.
  select count(*) into v_seen from public.credit_ledger
   where user_id = v_fb.author_id and kind = 'feedback_earned'
     and status in ('held', 'available')
     and created_at > now() - interval '24 hours';

  if v_seen >= v_day then
    update public.feedback set eligibility = 'ineligible',
           eligibility_reason = 'daily_cap_reached' where id = v_fb.id;
    return 'ineligible';
  end if;

  -- Per-creator cap.
  select count(*) into v_by_own from public.credit_ledger
   where user_id = v_fb.author_id and kind = 'feedback_earned'
     and status in ('held', 'available') and entry_id = v_fb.entry_id;

  if v_by_own >= v_crea then
    update public.feedback set eligibility = 'ineligible',
           eligibility_reason = 'per_creator_cap_reached' where id = v_fb.id;
    return 'ineligible';
  end if;

  -- Admin ceiling: at or above the max, no further earning. The spendable
  -- balance (0004 formula) is what is compared — held credits cannot be spent,
  -- so counting them here would block earning for money the member cannot use.
  -- Submissions are deliberately NOT blocked above a cap: spending is the only
  -- path back under it.
  v_cap := public.credit_cap_ceiling(v_fb.author_id);

  if v_cap is not null then
    select coalesce(sum(delta), 0)::integer into v_bal
      from public.credit_ledger
     where user_id = v_fb.author_id
       and status in ('available', 'spent');

    if v_bal >= v_cap then
      update public.feedback set eligibility = 'ineligible',
             eligibility_reason = 'cap_reached' where id = v_fb.id;
      return 'ineligible';
    end if;
  end if;

  -- ELIGIBLE -> a HELD credit with a review window. Held, not available: the brief
  -- requires a short window so an abusive item can be reversed before it is spent.
  insert into public.credit_ledger
    (user_id, delta, kind, status, entry_id, feedback_id, available_at, note)
  values
    (v_fb.author_id, v_amt, 'feedback_earned', 'held',
     v_fb.entry_id, v_fb.id, now() + make_interval(hours => v_hold),
     'Eligible peer feedback (pending review window)');

  update public.feedback set eligibility = 'eligible',
         hold_until = now() + make_interval(hours => v_hold)
   where id = v_fb.id;

  return 'eligible';
end;
$$;

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Same discipline as 0009/0014: this image grants EXECUTE to anon/authenticated
-- at CREATE time, so new functions must be revoked explicitly. `get_credit_summary`
-- is member-callable (self-or-admin is enforced inside); the sweeper and the
-- evaluator stay jobs-only; the ceiling helper is RPC-internals (SECURITY
-- DEFINER callers need no grant) and stays closed.

revoke execute on function public.get_credit_summary(uuid) from public;
revoke execute on function public.get_credit_summary(uuid) from anon;
revoke execute on function public.credit_cap_ceiling(uuid) from public;
revoke execute on function public.credit_cap_ceiling(uuid) from anon;
revoke execute on function public.credit_cap_ceiling(uuid) from authenticated;

grant execute on function public.get_credit_summary(uuid) to authenticated;
grant execute on function public.release_held_credits() to service_role;
grant execute on function public.grant_weekly_allowance(integer) to service_role;
grant execute on function public.evaluate_feedback_eligibility(uuid) to service_role;

revoke execute on function public.release_held_credits() from authenticated;
revoke execute on function public.grant_weekly_allowance(integer) from authenticated;
revoke execute on function public.evaluate_feedback_eligibility(uuid) from authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.get_credit_summary(uuid);
-- drop function if exists public.credit_cap_ceiling(uuid);
-- (release_held_credits, evaluate_feedback_eligibility and grant_weekly_allowance
--  revert to their 0004/0006 bodies on a down-migration; they are not dropped.)
