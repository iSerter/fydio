-- =============================================================================
-- T09 · 0027 — Feedback lifecycle: edit, remove, and eligibility reset
-- =============================================================================
--
-- The brief requires:
--   "The feedback giver can edit or remove their feedback until it is rated or
--    after a short grace period."
--
-- Editing resets eligibility and reverses any earned Credit, so an author cannot
-- qualify with a thoughtful critique and then edit it into spam without losing
-- the Credit.
--
-- Removing is a soft delete (`removed_at = now()`) that cascades to both ledgers:
-- reversing any Credit (0016) and reversing any Reputation (0018).

-- --- can_edit_feedback --------------------------------------------------------

create or replace function public.can_edit_feedback(p_feedback_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select f.author_id = auth.uid()
        and f.removed_at is null
        and not exists (select 1 from public.feedback_ratings r where r.feedback_id = f.id)
        and f.created_at > now() - make_interval(
              hours => public.app_setting_int('app.feedback_edit_grace_hours', 48))
     from public.feedback f
     where f.id = p_feedback_id),
    false
  );
$$;

-- --- reverse_credit_on_feedback_change ----------------------------------------
-- Helper function to reverse credit ledger rows when feedback is edited or removed.
-- Placed in its own function so that credit_ledger writes and reputation_ledger reads
-- are structurally separated (enforcing credit isolation).
create or replace function public.reverse_credit_on_feedback_change(
  p_feedback_id uuid,
  p_actor_id    uuid,
  p_note        text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select id, user_id, delta
      from public.credit_ledger
     where feedback_id = p_feedback_id
       and kind = 'feedback_earned'
       and status in ('held', 'available')
     for update
  loop
    update public.credit_ledger set status = 'reversed' where id = v_row.id;

    insert into public.credit_ledger
      (user_id, delta, kind, status, feedback_id, reverses_id, created_by, note)
    values
      (v_row.user_id, -v_row.delta, 'hold_reversal', 'reversed', p_feedback_id,
       v_row.id, p_actor_id, p_note);
  end loop;
end;
$$;

-- --- update_feedback ----------------------------------------------------------

create or replace function public.update_feedback(
  p_feedback_id uuid,
  p_body        text,
  p_tags        feedback_tag[] default '{}',
  p_image_paths text[] default '{}'
) returns public.feedback
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_fb       public.feedback;
  v_res      public.feedback;
  v_min      integer := public.app_setting_int('app.feedback_min_chars', 40);
  v_grace    integer := public.app_setting_int('app.feedback_edit_grace_hours', 48);
  v_eligible boolean;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_fb from public.feedback where id = p_feedback_id for update;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  if v_fb.author_id <> v_uid then
    raise exception 'You can only edit your own feedback'
      using errcode = 'insufficient_privilege';
  end if;

  if v_fb.removed_at is not null then
    raise exception 'Removed feedback cannot be edited'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.feedback_ratings where feedback_id = p_feedback_id) then
    raise exception 'Rated feedback cannot be edited'
      using errcode = 'check_violation';
  end if;

  if v_fb.created_at <= now() - make_interval(hours => v_grace) then
    raise exception 'The edit grace period has expired'
      using errcode = 'check_violation';
  end if;

  if char_length(p_body) < 10 or char_length(p_body) > 4000 then
    raise exception 'Feedback body must be between 10 and 4000 characters'
      using errcode = 'check_violation';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 3 then
    raise exception 'At most 3 images are allowed'
      using errcode = 'check_violation';
  end if;

  -- Editing text after a credit was earned resets eligibility and reverses any
  -- earned credit so editing cannot launder a credited item.
  perform public.reverse_credit_on_feedback_change(p_feedback_id, v_uid, 'Credit reversed: feedback edited');

  v_eligible := char_length(p_body) >= v_min or coalesce(array_length(p_image_paths, 1), 0) > 0;

  update public.feedback
     set body = p_body,
         tags = coalesce(p_tags, '{}'),
         image_paths = coalesce(p_image_paths, '{}'),
         eligibility = case when v_eligible then 'pending'::eligibility_state else 'ineligible'::eligibility_state end,
         eligibility_reason = case when v_eligible then null else 'below_quality_threshold' end,
         hold_until = null,
         edited_at = now()
   where id = p_feedback_id
   returning * into v_res;

  return v_res;
end;
$$;

-- --- remove_feedback ----------------------------------------------------------

create or replace function public.remove_feedback(p_feedback_id uuid)
returns public.feedback
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid            uuid := auth.uid();
  v_fb             public.feedback;
  v_res            public.feedback;
  v_rating_id      uuid;
  v_score          smallint;
  v_orig_ledger_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_fb from public.feedback where id = p_feedback_id for update;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  if v_fb.author_id <> v_uid and not public.is_admin() then
    raise exception 'You can only remove your own feedback'
      using errcode = 'insufficient_privilege';
  end if;

  if v_fb.removed_at is not null then
    raise exception 'Feedback already removed'
      using errcode = 'check_violation';
  end if;

  update public.feedback
     set removed_at = now(),
         eligibility = 'reversed'
   where id = p_feedback_id
   returning * into v_res;

  -- Credit reversal
  perform public.reverse_credit_on_feedback_change(p_feedback_id, v_uid, 'Credit reversed: feedback removed');

  -- Reputation reversal
  select id, score into v_rating_id, v_score
    from public.feedback_ratings
   where feedback_id = p_feedback_id;

  if v_rating_id is not null then
    select id into v_orig_ledger_id
      from public.reputation_ledger
     where rating_id = v_rating_id
       and kind = 'creator_rating'
     order by created_at asc
     limit 1;

    if v_orig_ledger_id is not null
       and not exists (
         select 1 from public.reputation_ledger
          where reverses_id = v_orig_ledger_id
            and kind = 'moderation_reversal'
       ) then
      perform pg_advisory_xact_lock(hashtext(v_fb.author_id::text));

      insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
      values (v_fb.author_id, -v_score::integer, 'moderation_reversal', v_rating_id, p_feedback_id, v_orig_ledger_id);

      perform public.refresh_profile_reputation(v_fb.author_id);
    end if;
  end if;

  insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
  values (
    v_uid,
    'feedback_removed',
    'feedback',
    p_feedback_id::text,
    jsonb_build_object('removed_by', case when public.is_admin() and v_fb.author_id <> v_uid then 'admin' else 'author' end)
  );

  return v_res;
end;
$$;

-- --- EXECUTE grants ----------------------------------------------------------

revoke execute on function public.can_edit_feedback(uuid) from public;
revoke execute on function public.can_edit_feedback(uuid) from anon;
grant execute on function public.can_edit_feedback(uuid) to authenticated;

revoke execute on function public.update_feedback(uuid, text, feedback_tag[], text[]) from public;
revoke execute on function public.update_feedback(uuid, text, feedback_tag[], text[]) from anon;
grant execute on function public.update_feedback(uuid, text, feedback_tag[], text[]) to authenticated;

revoke execute on function public.remove_feedback(uuid) from public;
revoke execute on function public.remove_feedback(uuid) from anon;
grant execute on function public.remove_feedback(uuid) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.remove_feedback(uuid);
-- drop function if exists public.update_feedback(uuid, text, feedback_tag[], text[]);
-- drop function if exists public.reverse_credit_on_feedback_change(uuid, uuid, text);
-- drop function if exists public.can_edit_feedback(uuid);
