-- =============================================================================
-- T06 · 0019 — revise_rating with reversing pairs
-- =============================================================================
--
-- Replaces the 0006 `revise_rating` (single net-delta row) with the T06 §5.3
-- reversing pair:
--
--   original:   +8  kind='creator_rating'
--   reversal:   -8  kind='rating_revision'   reverses_id -> original ledger row
--   correction: +5  kind='rating_revision'   reverses_id -> reversal row
--
-- Net movement is new-minus-old, so `sum(delta)` always equals the current
-- score, and the ledger shows what was first given and what it was changed to
-- rather than silently rewriting history. The `feedback_ratings.score` row is
-- still updated in place (it is the current truth; the ledger is the audit).
--
-- Rules preserved from 0006: original-rater-only, 1–10, revision window from
-- `app.rating_revision_window_hours` (default 24), advisory lock on the giver,
-- `refresh_profile_reputation` after every mutation. No `credit_ledger`
-- reference exists in this path — rating moves reputation and nothing else.

create or replace function public.revise_rating(p_feedback_id uuid, p_score smallint)
returns public.feedback_ratings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_rating   public.feedback_ratings;
  v_fb_author uuid;
  v_old      smallint;
  v_window   integer := public.app_setting_int('app.rating_revision_window_hours', 24);
  v_orig_ledger_id uuid;
  v_reversal_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_score < 1 or p_score > 10 then
    raise exception 'Rating must be between 1 and 10' using errcode = 'check_violation';
  end if;

  select * into v_rating from public.feedback_ratings where feedback_id = p_feedback_id for update;

  if not found then
    raise exception 'This feedback has not been rated' using errcode = 'no_data_found';
  end if;

  if v_rating.rater_id <> v_uid then
    raise exception 'Only the original rater can revise a rating'
      using errcode = 'insufficient_privilege';
  end if;

  if now() > v_rating.created_at + make_interval(hours => v_window) then
    raise exception 'The revision window has closed'
      using errcode = 'check_violation';
  end if;

  select author_id into v_fb_author from public.feedback where id = p_feedback_id;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  if p_score = v_rating.score then
    -- No movement: still stamp the revision so the window semantics stay honest.
    update public.feedback_ratings
       set revised_at = now()
     where id = v_rating.id
    returning * into v_rating;

    return v_rating;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_fb_author::text));

  v_old := v_rating.score;

  -- The original positive row this revision undoes: the earliest
  -- `creator_rating` row for this rating. (Normally exactly one.)
  select id into v_orig_ledger_id
    from public.reputation_ledger
   where rating_id = v_rating.id
     and kind = 'creator_rating'
   order by created_at asc
   limit 1;

  update public.feedback_ratings
     set score = p_score, revised_at = now()
   where id = v_rating.id;

  -- Row 1 of the pair: undo the old score. When the original ledger row cannot
  -- be found (a legacy net-delta row from 0006, which carries no reverses_id),
  -- the reversal still records the arithmetic with a NULL link rather than
  -- failing the member's correction.
  insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
  values (v_fb_author, -v_old::integer, 'rating_revision', v_rating.id, p_feedback_id, v_orig_ledger_id)
  returning id into v_reversal_id;

  -- Row 2 of the pair: apply the new score, chained to the reversal above.
  insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
  values (v_fb_author, p_score::integer, 'rating_revision', v_rating.id, p_feedback_id, v_reversal_id);

  perform public.refresh_profile_reputation(v_fb_author);

  select * into v_rating from public.feedback_ratings where id = v_rating.id;
  return v_rating;
end;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- (revise_rating reverts to its 0006 body on a down-migration.)
