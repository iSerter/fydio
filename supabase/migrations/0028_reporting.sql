-- =============================================================================
-- T09 · 0028 — Content reporting
-- =============================================================================
--
-- Members can report content entries, feedback, user profiles, and hashtags.
-- Reports land in `moderation_reports` in the 'open' state and surface in the
-- admin moderation queue.
--
-- Reporting a feedback item immediately holds any credit release (enforced by
-- `release_held_credits` and `evaluate_feedback_eligibility`), preventing
-- reported items from paying out before an admin investigates.

create or replace function public.report_content(
  p_target_type report_target,
  p_target_id   text,
  p_reason      text,
  p_details     text default null
) returns public.moderation_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_report public.moderation_reports;
  v_uuid   uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 200 then
    raise exception 'Report reason must be between 3 and 200 characters'
      using errcode = 'check_violation';
  end if;

  if p_details is not null and char_length(p_details) > 2000 then
    raise exception 'Report details must be 2000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  -- Validate target existence and refuse self-reporting
  case p_target_type
    when 'content_entry' then
      begin
        v_uuid := p_target_id::uuid;
      exception when others then
        raise exception 'Invalid entry ID format' using errcode = 'check_violation';
      end;

      if not exists (select 1 from public.content_entries where id = v_uuid) then
        raise exception 'Content entry not found' using errcode = 'no_data_found';
      end if;

      if exists (select 1 from public.content_entries where id = v_uuid and author_id = v_uid) then
        raise exception 'You cannot report your own entry' using errcode = 'check_violation';
      end if;

    when 'feedback' then
      begin
        v_uuid := p_target_id::uuid;
      exception when others then
        raise exception 'Invalid feedback ID format' using errcode = 'check_violation';
      end;

      if not exists (select 1 from public.feedback where id = v_uuid) then
        raise exception 'Feedback not found' using errcode = 'no_data_found';
      end if;

      if exists (select 1 from public.feedback where id = v_uuid and author_id = v_uid) then
        raise exception 'You cannot report your own feedback' using errcode = 'check_violation';
      end if;

    when 'user' then
      begin
        v_uuid := p_target_id::uuid;
      exception when others then
        raise exception 'Invalid user ID format' using errcode = 'check_violation';
      end;

      if not exists (select 1 from public.profiles where id = v_uuid) then
        raise exception 'User not found' using errcode = 'no_data_found';
      end if;

      if v_uuid = v_uid then
        raise exception 'You cannot report yourself' using errcode = 'check_violation';
      end if;

    when 'hashtag' then
      if not exists (
        select 1 from public.hashtags
         where id::text = p_target_id or slug = p_target_id
      ) then
        raise exception 'Hashtag not found' using errcode = 'no_data_found';
      end if;
  end case;

  if exists (
    select 1 from public.moderation_reports
     where reporter_id = v_uid
       and target_type = p_target_type
       and target_id = p_target_id
       and state in ('open', 'reviewing')
  ) then
    raise exception 'You have already reported this item'
      using errcode = 'unique_violation';
  end if;

  insert into public.moderation_reports (
    reporter_id, target_type, target_id, reason, details, state
  )
  values (
    v_uid, p_target_type, p_target_id, trim(p_reason), p_details, 'open'
  )
  returning * into v_report;

  return v_report;
end;
$$;

-- --- EXECUTE grants ----------------------------------------------------------

revoke execute on function public.report_content(report_target, text, text, text) from public;
revoke execute on function public.report_content(report_target, text, text, text) from anon;
grant execute on function public.report_content(report_target, text, text, text) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.report_content(report_target, text, text, text);
