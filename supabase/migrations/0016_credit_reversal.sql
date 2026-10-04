-- =============================================================================
-- T05 · 0016 — Credit reversal on abuse + resolve-report wiring
-- =============================================================================
--
-- When feedback is removed for abuse, any credit it produced must be undone
-- without deleting history. The accounting follows the 0004 rule exactly:
--
--   * the ORIGINAL row flips to `reversed` (removing its contribution), and
--   * the paired audit row is ALSO `reversed`, so it contributes nothing itself
--     and exists purely as evidence (`reverses_id` points at the original).
--
-- The T05 task text sketched the pair as a negative `available` sibling. That
-- shape double-subtracts under the real balance formula (`available` + `spent`
-- are both summed): flipping the original already removes +1, and a negative
-- `available` sibling removes another +1. Both shapes cannot coexist, so this
-- migration implements the 0004 rule and `admin_resolve_report` is rewired to
-- call it rather than flipping rows inline without an audit pair.

-- --- reverse_credit_for_feedback -------------------------------------------------
--
-- Admin-only (abuse handling is a moderation act, and every moderation act is
-- audited). Idempotent: a second call finds no `held`/`available` rows for the
-- feedback and returns 0, so a retried resolution cannot subtract twice.
--
-- Reverses ALL earned rows for the feedback (there is normally one; the loop
-- makes a historical double-grant safe rather than silently partial).

create or replace function public.reverse_credit_for_feedback(
  p_feedback_id uuid,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      record;
  v_reversed integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.feedback where id = p_feedback_id) then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  -- Serialise concurrent resolutions of the same feedback: two overlapping
  -- calls must not both see the row as reversible. `for update` in the loop
  -- cursor plus the status filter makes the second call see nothing to do.
  for v_row in
    select id, user_id, delta
      from public.credit_ledger
     where feedback_id = p_feedback_id
       and kind = 'feedback_earned'
       and status in ('held', 'available')
     for update
  loop
    -- The original stops counting.
    update public.credit_ledger set status = 'reversed' where id = v_row.id;

    -- The audit pair records what happened and why. `reversed` means this row
    -- is itself excluded from the balance — it is evidence, not a second
    -- deduction. (`credit_reversal_pairing` requires `reverses_id` exactly for
    -- `hold_reversal`, and `credit_reversal_is_negative` requires the
    -- negative delta; both constraints are satisfied by construction.)
    insert into public.credit_ledger
      (user_id, delta, kind, status, feedback_id, reverses_id, created_by, note)
    values
      (v_row.user_id, -v_row.delta, 'hold_reversal', 'reversed', p_feedback_id,
       v_row.id, auth.uid(),
       coalesce(p_note, 'Credit reversed: feedback removed for abuse'));

    v_reversed := v_reversed + 1;
  end loop;

  update public.feedback set eligibility = 'reversed' where id = p_feedback_id;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'credit_reversed', 'feedback', p_feedback_id::text,
          jsonb_build_object('reversed_count', v_reversed, 'note', p_note));

  return v_reversed;
end;
$$;

-- --- admin_resolve_report: route feedback removals through the reversal ------------
--
-- Full body from 0010 with one change: the `resolved` + `feedback` branch now
-- calls `reverse_credit_for_feedback` instead of flipping ledger rows inline.
-- The inline flip removed the credit but left no audit pair; the function
-- leaves the pair and the `credit_reversed` moderation action, while this
-- caller keeps its own `feedback_removed` + `report_resolved` actions and the
-- `removed_at` stamp (which the reversal function deliberately does not set —
-- removal is a moderation state, reversal is an accounting act).

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

  -- Only a resolution against a live report takes action. A dismissal must not
  -- remove content: dismissing a report says the report was wrong, and acting on
  -- it would punish the reported member for being falsely accused.
  if p_state = 'resolved' and v_row.target_type = 'feedback' then
    update public.feedback set removed_at = now() where id = v_row.target_id::uuid;

    -- Paired reversal (0016 rule): flips the earned row, writes the audit pair,
    -- marks eligibility `reversed`. A no-op returning 0 when the feedback never
    -- earned — which is correct, not an error.
    perform public.reverse_credit_for_feedback(
      v_row.target_id::uuid,
      coalesce(p_note, 'Credit reversed: feedback removed for abuse')
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
-- Admin-only function, same shape as 0010: granted to `authenticated` because
-- an admin is an in-app role, with the `is_admin()` check inside as the gate.
-- (`revoke ... from public` is insufficient on this image — see 0009.)

revoke execute on function public.reverse_credit_for_feedback(uuid, text) from public;
revoke execute on function public.reverse_credit_for_feedback(uuid, text) from anon;

grant execute on function public.reverse_credit_for_feedback(uuid, text) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.reverse_credit_for_feedback(uuid, text);
-- (admin_resolve_report reverts to its 0010 body on a down-migration.)
