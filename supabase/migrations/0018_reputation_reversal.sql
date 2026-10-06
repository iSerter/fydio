-- =============================================================================
-- T06 · 0018 — Moderation reversal for reputation
-- =============================================================================
--
-- When abusive feedback is removed, the reputation it produced must be undone
-- without deleting history. The ledger is append-only (0006 trigger forbids
-- UPDATE/DELETE), so the reversal is a new negative row, never an edit:
--
--   original:  +8  kind='creator_rating'
--   reversal:  -8  kind='moderation_reversal'  reverses_id -> original row
--
-- `sum(delta)` therefore nets out, `refresh_profile_reputation` recomputes the
-- aggregates from the ledger, and the audit row in `moderation_actions` records
-- who did it and why. Idempotent: a second call finds no unreversed positive
-- rows for the feedback and returns 0, so a retried moderation cannot subtract
-- twice.
--
-- Called by `admin_resolve_report` (rewired below) and directly by T09's admin
-- action. Rating-independent: works whether or not the feedback ever earned a
-- credit — the two ledgers never meet.

create or replace function public.reverse_reputation_for_feedback(
  p_feedback_id uuid,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_giver uuid;
  v_rating_id uuid;
  v_score smallint;
  v_orig_ledger_id uuid;
  v_reversed integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  select author_id into v_giver from public.feedback where id = p_feedback_id;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  select id, score into v_rating_id, v_score
    from public.feedback_ratings
   where feedback_id = p_feedback_id;

  -- Unrated feedback produced no reputation: still audited, nothing to reverse.
  if v_rating_id is null then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
    values (auth.uid(), 'reputation_reversed', 'feedback', p_feedback_id::text,
            jsonb_build_object('score_reversed', 0, 'note', p_note));

    return 0;
  end if;

  -- Already fully reversed? The reversal rows reference the original positive
  -- row via `reverses_id`, so completeness is checkable without a separate flag.
  select id into v_orig_ledger_id
    from public.reputation_ledger
   where rating_id = v_rating_id
     and kind = 'creator_rating'
   order by created_at asc
   limit 1;

  if v_orig_ledger_id is not null
     and exists (
       select 1 from public.reputation_ledger
        where reverses_id = v_orig_ledger_id
          and kind = 'moderation_reversal'
     ) then
    insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
    values (auth.uid(), 'reputation_reversed', 'feedback', p_feedback_id::text,
            jsonb_build_object('score_reversed', 0, 'note', p_note, 'already_reversed', true));

    return 0;
  end if;

  -- Serialise concurrent resolutions of the same feedback.
  perform pg_advisory_xact_lock(hashtext(v_giver::text));

  insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
  values (v_giver, -v_score::integer, 'moderation_reversal', v_rating_id, p_feedback_id, v_orig_ledger_id);

  perform public.refresh_profile_reputation(v_giver);

  v_reversed := 1;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'reputation_reversed', 'feedback', p_feedback_id::text,
          jsonb_build_object('score_reversed', v_score, 'note', p_note));

  return v_reversed;
end;
$$;

-- --- admin_resolve_report: route feedback removals through BOTH reversals -------
--
-- Full body from 0016 with one addition: the `resolved` + `feedback` branch now
-- also calls `reverse_reputation_for_feedback`. Credits (0016) and reputation
-- (this migration) are reversed by separate functions touching separate ledgers —
-- the separation the brief requires, preserved at the call site too.

create or replace function public.admin_resolve_report(
  p_report_id uuid,
  p_state     report_state,
  p_note      text default null
) returns public.moderation_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.moderation_reports;
  v_row    public.moderation_reports;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  if p_state not in ('resolved', 'dismissed') then
    raise exception 'A report must be resolved or dismissed, not moved to %', p_state
      using errcode = 'check_violation';
  end if;

  select * into v_row from public.moderation_reports where id = p_report_id for update;

  if not found then
    raise exception 'Report not found' using errcode = 'no_data_found';
  end if;

  if v_row.state in ('resolved', 'dismissed') then
    raise exception 'Report is already closed' using errcode = 'check_violation';
  end if;

  if p_state = 'resolved' and v_row.target_type = 'feedback' then
    update public.feedback set removed_at = now() where id = v_row.target_id::uuid;

    perform public.reverse_credit_for_feedback(
      v_row.target_id::uuid,
      coalesce(p_note, 'Credit reversed: feedback removed for abuse')
    );

    -- Reputation half. A no-op returning 0 when the feedback was never rated —
    -- correct, not an error.
    perform public.reverse_reputation_for_feedback(
      v_row.target_id::uuid,
      coalesce(p_note, 'Reputation reversed: feedback removed for abuse')
    );

    insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
    values (auth.uid(), 'feedback_removed', 'feedback', v_row.target_id,
            jsonb_build_object('report_id', p_report_id));
  end if;

  if p_state = 'resolved' and v_row.target_type = 'content_entry' then
    update public.content_entries
       set status = 'hidden', deleted_at = now()
     where id = v_row.target_id::uuid;

    insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
    values (auth.uid(), 'entry_hidden', 'content_entry', v_row.target_id,
            jsonb_build_object('report_id', p_report_id));
  end if;

  update public.moderation_reports
     set state = p_state,
         resolved_by = auth.uid(),
         resolved_at = now(),
         resolution_note = p_note
   where id = p_report_id
   returning * into v_report;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'report_resolved', v_row.target_type, v_row.target_id,
          jsonb_build_object('report_id', p_report_id, 'state', p_state, 'note', p_note));

  return v_report;
end;
$$;

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Admin-only function, same shape as 0010/0016: granted to `authenticated`
-- because an admin is an in-app role, with the `is_admin()` check inside as the
-- gate.

revoke execute on function public.reverse_reputation_for_feedback(uuid, text) from public;
revoke execute on function public.reverse_reputation_for_feedback(uuid, text) from anon;

grant execute on function public.reverse_reputation_for_feedback(uuid, text) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.reverse_reputation_for_feedback(uuid, text);
-- (admin_resolve_report reverts to its 0016 body on a down-migration.)
