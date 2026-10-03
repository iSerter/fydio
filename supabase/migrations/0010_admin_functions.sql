-- =============================================================================
-- T02 · 0010 — Admin operations
-- =============================================================================
--
-- Every function here is SECURITY DEFINER, checks `is_admin()` itself, and writes
-- a `moderation_actions` row. Two reasons, both deliberate:
--
--   1. SECURITY DEFINER bypasses RLS, so the admin policies in 0009 are not the
--      gate — the `is_admin()` check inside each function is. Revoking EXECUTE
--      from `authenticated` (last statement) means a non-admin cannot even attempt
--      the call, so the in-function check is defence in depth rather than the only
--      barrier.
--   2. "Admins can grant, reverse, or cap Credits for abuse handling and
--      onboarding" (brief §2). Those are discretionary acts, and discretionary acts
--      are exactly what an audit trail is for. Writing `moderation_actions` is not
--      optional here — there is no path in this file that skips it.

-- --- admin_grant_credit -------------------------------------------------------------

create or replace function public.admin_grant_credit(
  p_user_id uuid,
  p_amount  integer,
  p_note    text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  if p_amount = 0 then
    raise exception 'Grant amount must be non-zero' using errcode = 'check_violation';
  end if;

  insert into public.credit_ledger (user_id, delta, kind, status, created_by, note)
  values (p_user_id, p_amount, 'admin_grant', 'available', auth.uid(), coalesce(p_note, 'Admin grant'));

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'credit_grant', 'user', p_user_id::text,
          jsonb_build_object('amount', p_amount, 'note', p_note));

  select public.get_credit_balance(p_user_id) into v_balance;
  return v_balance;
end;
$$;

-- --- admin_reverse_credit ------------------------------------------------------------
--
-- Follows the accounting rule in 0004 exactly: the ORIGINAL row is flipped to
-- `reversed`, which removes its contribution, and the paired audit row is also
-- `reversed`, so it contributes nothing of its own. The balance therefore falls by
-- exactly the reversed amount, once. Reversing several rows for the same
-- punishment is the caller's choice, and each one is separately auditable.

create or replace function public.admin_reverse_credit(
  p_user_id    uuid,
  p_ledger_id  uuid,
  p_note       text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.credit_ledger;
  v_balance integer;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row
    from public.credit_ledger
   where id = p_ledger_id and user_id = p_user_id
   for update;

  if not found then
    raise exception 'Ledger row not found' using errcode = 'no_data_found';
  end if;

  if v_row.status = 'reversed' then
    raise exception 'Already reversed' using errcode = 'check_violation';
  end if;

  -- The original stops counting.
  update public.credit_ledger set status = 'reversed' where id = p_ledger_id;

  -- The audit pair records what happened and why. `reversed` means this row is
  -- itself excluded from the balance — it is evidence, not a second deduction.
  insert into public.credit_ledger (user_id, delta, kind, status, reverses_id, created_by, note)
  values (p_user_id, -v_row.delta, 'admin_reverse', 'reversed', p_ledger_id, auth.uid(),
          coalesce(p_note, 'Admin reversal'));

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'credit_reverse', 'user', p_user_id::text,
          jsonb_build_object('ledger_id', p_ledger_id, 'amount', v_row.delta, 'note', p_note));

  select public.get_credit_balance(p_user_id) into v_balance;
  return v_balance;
end;
$$;

-- --- admin_cap_credit ----------------------------------------------------------------
--
-- Brings a balance DOWN to a ceiling by reversing the most recent grants until it
-- fits. Reversing oldest-first would let someone shelter a fraudulent grant behind
-- a legitimate one; newest-first removes what was added last, which is the more
-- likely thing to be illegitimate.

create or replace function public.admin_cap_credit(
  p_user_id uuid,
  p_cap     integer,
  p_note    text default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
  v_row     record;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  select public.get_credit_balance(p_user_id) into v_balance;

  while v_balance > p_cap loop
    select * into v_row
      from public.credit_ledger
     where user_id = p_user_id
       and delta > 0
       and status in ('available', 'held')
     order by created_at desc, id desc
     limit 1
     for update;

    if not found then
      -- Nothing left to claw back. A balance above the cap made of spends cannot
      -- be reduced by reversing grants, and reporting that plainly beats looping.
      raise notice 'admin_cap_credit: no positive ledger rows remain to reverse';
      exit;
    end if;

    update public.credit_ledger set status = 'reversed' where id = v_row.id;

    insert into public.credit_ledger (user_id, delta, kind, status, reverses_id, created_by, note)
    values (p_user_id, -v_row.delta, 'admin_reverse', 'reversed', v_row.id, auth.uid(),
            coalesce(p_note, 'Admin cap'));

    v_balance := v_balance - v_row.delta;
  end loop;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'credit_cap', 'user', p_user_id::text,
          jsonb_build_object('cap', p_cap, 'note', p_note));

  return v_balance;
end;
$$;

-- --- admin_set_role ------------------------------------------------------------------
--
-- Guards the last admin. Demoting the only admin would leave the community with no
-- one able to moderate, and there would be no account left with the rights to fix
-- it — a genuine lockout, not a hypothetical.

create or replace function public.admin_set_role(p_user_id uuid, p_role profile_role)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.profiles;
  v_admins integer;
begin
  if not public.is_admin() then
    raise exception 'Admin only' using errcode = 'insufficient_privilege';
  end if;

  if p_role = 'member' then
    select count(*) into v_admins from public.profiles where role = 'admin';

    if v_admins <= 1 then
      raise exception 'Cannot demote the last admin' using errcode = 'check_violation';
    end if;
  end if;

  -- Bypasses profiles_guard_reputation, which refuses a self-service role change.
  update public.profiles set role = p_role where id = p_user_id returning * into v_row;

  if not found then
    raise exception 'Profile not found' using errcode = 'no_data_found';
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'set_role', 'user', p_user_id::text, jsonb_build_object('role', p_role));

  return v_row;
end;
$$;

-- --- admin_resolve_report ----------------------------------------------------------------
--
-- Resolving a report can cascade: a report against a feedback item removes it and
-- reverses the Credit it earned; a report against an entry hides it and reverses
-- the submission spend. Both reversals follow the 0004 accounting rule, so the
-- balance moves by exactly the amount once.

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

    update public.credit_ledger set status = 'reversed'
     where feedback_id = v_row.target_id::uuid and status in ('held', 'available');

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

-- --- EXECUTE grants ---------------------------------------------------------------------
--
-- Granted to `authenticated` (not `service_role`) because an admin is an in-app
-- role, not a separate credential: the same signed-in session that reads the feed
-- can moderate. Every one of these re-checks `is_admin()` internally, since
-- SECURITY DEFINER bypasses RLS and the policy layer is not the gate.

grant execute on function public.admin_grant_credit(uuid, integer, text) to authenticated;
grant execute on function public.admin_reverse_credit(uuid, uuid, text) to authenticated;
grant execute on function public.admin_cap_credit(uuid, integer, text) to authenticated;
grant execute on function public.admin_set_role(uuid, profile_role) to authenticated;
grant execute on function public.admin_resolve_report(uuid, report_state, text) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.admin_resolve_report(uuid, report_state, text);
-- drop function if exists public.admin_set_role(uuid, profile_role);
-- drop function if exists public.admin_cap_credit(uuid, integer, text);
-- drop function if exists public.admin_reverse_credit(uuid, uuid, text);
-- drop function if exists public.admin_grant_credit(uuid, integer, text);
