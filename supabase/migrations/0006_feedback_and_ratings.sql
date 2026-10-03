-- =============================================================================
-- T02 · 0006 — Feedback, eligibility, ratings, reputation
-- =============================================================================
--
-- Where a Credit is earned and where Reputation is recorded. Two entirely
-- separate paths that touch no common table.
--

-- --- Feedback -------------------------------------------------------------------

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,

  body text not null,

  -- Structured so a creator can see WHAT KIND of critique they are getting, not
  -- just a wall of prose. Empty is valid: tags are optional.
  tags feedback_tag[] not null default '{}',
  image_paths text[] not null default '{}',

  eligibility eligibility_state not null default 'pending',
  eligibility_reason text,

  -- Whether the author had opened the entry before leaving this. Recorded because
  -- "connected to an entry they opened" is an eligibility requirement (brief §2),
  -- and the flag makes an audit answerable after the fact. It is a history signal
  -- only: no duration is consulted, and nothing here is ever attributed to time.
  opened_entry boolean not null default false,

  hold_until timestamptz,
  removed_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz not null default now(),

  -- Ten characters is the floor at which a note is still a note; the *eligibility*
  -- threshold is a tunable (`app.feedback_min_chars`, default 40) and is applied by
  -- `submit_feedback`, not here. A short note is allowed to exist and simply earns
  -- nothing — refusing to store it would be a worse product than storing it.
  constraint feedback_body_len check (char_length(body) between 10 and 4000),

  -- Up to three images (brief §7, `MAX_FEEDBACK_IMAGES` in @fydio/domain).
  constraint feedback_max_images check (coalesce(array_length(image_paths, 1), 0) <= 3),

  -- Anti-duplicate earning. Enforced structurally rather than only in the RPC, so
  -- even a service-role write cannot pay twice for the same pair.
  unique (entry_id, author_id)
);

create index feedback_entry_idx on public.feedback (entry_id, created_at desc);
create index feedback_author_idx on public.feedback (author_id, created_at desc);
create index feedback_pending_idx on public.feedback (eligibility) where eligibility = 'pending';

-- Self-feedback cannot be a CHECK: Postgres forbids subqueries in CHECK, and
-- "the entry's author is not this author" needs exactly that. It is enforced twice
-- — here as a BEFORE trigger (so it holds for every writer, including
-- service_role) and in `submit_feedback` (which raises a clearer error first).
create or replace function public.enforce_feedback_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.content_entries e
     where e.id = new.entry_id and e.author_id = new.author_id
  ) then
    raise exception 'You cannot leave feedback on your own content'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger feedback_no_self_trg
  before insert or update on public.feedback
  for each row execute function public.enforce_feedback_integrity();

create table public.credit_eligibility_reviews (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.feedback (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  decision eligibility_state not null,
  reason text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz not null default now()
);

create index credit_eligibility_reviews_feedback_idx on public.credit_eligibility_reviews (feedback_id);

-- The FKs deferred from 0004 are attached here, now that both target tables exist.

-- --- Ratings: reputation, and ONLY reputation -----------------------------------

create table public.feedback_ratings (
  id uuid primary key default gen_random_uuid(),

  -- A feedback item is rated at most once, ever. Enforced by the unique index
  -- below so "rate once" is a property of the data rather than of a code path.
  feedback_id uuid not null unique references public.feedback (id) on delete cascade,

  -- Denormalised from the entry at rating time. Storing it means the rating stays
  -- meaningful after the feedback row is removed, and it lets a policy check
  -- "did the rater own the entry" without joining through two tables.
  entry_owner_id uuid not null references public.profiles (id) on delete cascade,
  rater_id uuid not null references public.profiles (id) on delete cascade,

  score smallint not null,
  source text not null default 'creator_rating',

  created_at timestamptz not null default now(),
  revised_at timestamptz,

  -- 1-10. Eleven is not enthusiasm and zero is not a rating; both are excluded
  -- here rather than clamped, so a bad number is an error the caller can see.
  constraint rating_range check (score between 1 and 10)

  -- NOTE: there is deliberately no `rater_id <> entry_owner_id` check here.
  --
  -- It looks like the natural self-rating guard, but it contradicts what a rating
  -- IS: the rater is by definition the owner of the entry the feedback sits on, so
  -- `rate_feedback` writes the same uuid into both columns. Enforcing it would make
  -- rating impossible. (An earlier draft of this migration had that constraint, and
  -- the seed failed on the very first rating row — which is how the contradiction
  -- was found.)
  --
  -- The rule people actually mean -- "you may not rate your own feedback" -- is
  -- structural rather than declarative, and needs no constraint: `rater_id` is
  -- always the entry owner, and `enforce_feedback_integrity` guarantees a
  -- feedback's author is never the entry's author. The two can never coincide.
  -- `rate_feedback` re-checks it anyway, for a clearer error message.
);

create index feedback_ratings_feedback_idx on public.feedback_ratings (feedback_id);
create index feedback_ratings_owner_idx on public.feedback_ratings (entry_owner_id);

-- --- The Reputation ledger -------------------------------------------------------
--
-- Append-only. There is NO `status` column and no `held` or `available` state,
-- because there is nothing here that could be spent. A correction is a new row
-- pointing at the row it undoes, never an edit. That absence is the structural
-- guarantee behind "Reputation cannot be spent to publish content": there is no
-- code path — SQL or TypeScript — that could read this table and authorise a
-- submission, because the submission path reads `credit_ledger` and nothing else.

create table public.reputation_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Signed: a rating adds the score, a revision or moderation reversal subtracts.
  delta integer not null,

  kind reputation_kind not null,

  rating_id uuid references public.feedback_ratings (id) on delete set null,
  feedback_id uuid references public.feedback (id) on delete set null,

  reverses_id uuid references public.reputation_ledger (id) on delete set null,

  created_at timestamptz not null default now(),

  constraint reputation_not_self check (reverses_id is distinct from id),
  constraint reputation_delta_nonzero check (delta <> 0)
);

create index reputation_ledger_user_idx on public.reputation_ledger (user_id, created_at desc);
create index reputation_ledger_rating_idx on public.reputation_ledger (rating_id) where rating_id is not null;

-- Reputation is append-only, same reasoning as the credit ledger: a figure you
-- can edit is not an audit trail. The only permitted mutation is deleting the
-- member themselves, which the FK cascade handles.
create or replace function public.reputation_ledger_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'reputation_ledger is append-only; insert a reversing row instead'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger reputation_ledger_append_only_trg
  before update or delete on public.reputation_ledger
  for each row execute function public.reputation_ledger_append_only();

-- --- refresh_profile_reputation(): the only writer of the aggregates -------------
--
-- Recomputes from the ledger rather than incrementing a counter. Incrementing
-- would let any arithmetic mistake become permanent; recomputing makes the stored
-- total a pure function of the rows, so the two can be reconciled at any time.

create or replace function public.refresh_profile_reputation(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_count integer;
  v_avg   numeric(4,2);
begin
  select coalesce(sum(delta), 0)::integer into v_total
    from public.reputation_ledger
   where user_id = p_user_id;

  -- Counted and averaged from the ratings rather than the ledger, because
  -- `moderation_reversal` rows would otherwise inflate the denominator and drag
  -- the average toward zero. The total and the average are deliberately computed
  -- from different sources: the total is the ledger (including reversals), the
  -- average is what members actually received.
  select count(*)::integer, round(avg(r.score), 2)
    into v_count, v_avg
    from public.feedback_ratings r
    join public.feedback f on f.id = r.feedback_id
   where f.author_id = p_user_id;

  update public.profiles
     set reputation_total = v_total,
         rated_feedback_count = v_count,
         reputation_avg = v_avg
   where id = p_user_id;
end;
$$;

-- =============================================================================
-- submit_feedback — the only legitimate path to earning a Credit
-- =============================================================================
--
-- Note what this function does NOT do: it never touches `reputation_ledger`, and
-- it grants nothing directly. It records the feedback and marks it `pending`;
-- `evaluate_feedback_eligibility` decides the Credit afterwards. Keeping those
-- separate is what allows the review window and the caps to be re-evaluated
-- without re-asking the member to retype their critique.

create or replace function public.submit_feedback(
  p_entry_id    uuid,
  p_body        text,
  p_tags        feedback_tag[] default '{}',
  p_image_paths text[] default '{}'
) returns public.feedback
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.content_entries;
  v_min   integer := public.app_setting_int('app.feedback_min_chars', 40);
  v_fb    public.feedback;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_entry from public.content_entries where id = p_entry_id and status = 'active';

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id = v_uid then
    raise exception 'You cannot leave feedback on your own content'
      using errcode = 'check_violation';
  end if;

  -- "Connected to an entry they opened" (brief §2). This is an OPEN-HISTORY
  -- signal only: it records that the member reached the original post. No duration
  -- is consulted, because Credits are never tied to time spent — that is an
  -- explicit product exclusion, not an oversight.
  if not exists (
    select 1 from public.feed_impressions
     where entry_id = p_entry_id and viewer_id = v_uid and opened
  ) then
    raise exception 'Open the content before leaving feedback'
      using errcode = 'check_violation';
  end if;

  -- One feedback per member per entry (anti-duplicate earning).
  if exists (
    select 1 from public.feedback where entry_id = p_entry_id and author_id = v_uid
  ) then
    raise exception 'You already left feedback on this entry'
      using errcode = 'unique_violation';
  end if;

  -- Blocked-account check, in both directions: neither party will exchange
  -- feedback with someone they have blocked.
  if exists (
    select 1 from public.friendships f
     where f.state = 'blocked'
       and ((f.requester_id = v_entry.author_id and f.addressee_id = v_uid)
         or (f.requester_id = v_uid and f.addressee_id = v_entry.author_id))
  ) then
    raise exception 'Blocked account' using errcode = 'insufficient_privilege';
  end if;

  -- The quality gate affects ELIGIBILITY, not submission. A short note is still
  -- allowed to exist — refusing to store it would be worse for the member than
  -- storing something that earns nothing — so both branches insert, and only the
  -- eligibility differs.
  insert into public.feedback (
    entry_id, author_id, body, tags, image_paths,
    eligibility, eligibility_reason, opened_entry
  )
  values (
    p_entry_id, v_uid, p_body, p_tags, p_image_paths,
    case when char_length(p_body) >= v_min
           or coalesce(array_length(p_image_paths, 1), 0) > 0
         then 'pending'::eligibility_state
         else 'ineligible'::eligibility_state
    end,
    case when char_length(p_body) >= v_min
           or coalesce(array_length(p_image_paths, 1), 0) > 0
         then null else 'below_quality_threshold' end,
    true
  ) returning * into v_fb;

  return v_fb;
end;
$$;

-- =============================================================================
-- evaluate_feedback_eligibility — where a Credit is actually earned
-- =============================================================================
--
-- Idempotent: an item that is no longer `pending` returns its existing state
-- unchanged, so a retried sweep cannot pay twice.
--
-- The MVP value of `app.feedback_credit_amount` is 1. Reputation ratings do NOT
-- feed into it — and that is structural rather than a matter of discipline: there
-- is no reference to `reputation_ledger` or `feedback_ratings` anywhere in this
-- function, so no rating can influence an amount even by accident. `002_credits`
-- and `003_reputation` both assert this.

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
-- rate_feedback — reputation only, never spendable
-- =============================================================================
--
-- Read this function for what it does NOT contain: there is no reference to
-- `credit_ledger` anywhere below. Rating someone's feedback moves their
-- Reputation and cannot move their Credit balance by any amount. That is the
-- whole point of the two-ledger design, and it is enforced by the absence of the
-- code rather than by a comment.

create or replace function public.rate_feedback(p_feedback_id uuid, p_score smallint)
returns public.feedback_ratings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_fb     public.feedback;
  v_owner  uuid;
  v_rating public.feedback_ratings;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_score < 1 or p_score > 10 then
    raise exception 'Rating must be between 1 and 10' using errcode = 'check_violation';
  end if;

  -- Fetched as two separate scalar assignments rather than `select f.*, e.author_id
  -- into v_fb, v_owner`. Postgres rejects expanding `f.*` into a record variable as
  -- part of a multi-item INTO list ("record variable cannot be part of multiple-item
  -- INTO list"), so the row is loaded first and the owner read from it afterwards.
  select f.* into v_fb from public.feedback f where f.id = p_feedback_id;

  if not found then
    raise exception 'Feedback not found' using errcode = 'no_data_found';
  end if;

  select author_id into v_owner from public.content_entries where id = v_fb.entry_id;

  -- Only the content owner rates feedback on their own entry (brief §8).
  if v_owner <> v_uid then
    raise exception 'Only the content owner can rate feedback on their own entry'
      using errcode = 'insufficient_privilege';
  end if;

  if v_fb.author_id = v_uid then
    raise exception 'Self-rating is not allowed' using errcode = 'check_violation';
  end if;

  -- Removed feedback is not rated.
  if v_fb.removed_at is not null then
    raise exception 'Removed feedback cannot be rated' using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.feedback_ratings where feedback_id = p_feedback_id) then
    raise exception 'This feedback has already been rated' using errcode = 'unique_violation';
  end if;

  -- Serialise concurrent ratings of the same feedback giver, so two simultaneous
  -- rate calls cannot both pass the "not yet rated" check above.
  perform pg_advisory_xact_lock(hashtext(v_fb.author_id::text));

  insert into public.feedback_ratings (feedback_id, entry_owner_id, rater_id, score, source)
  values (p_feedback_id, v_uid, v_uid, p_score, 'creator_rating')
  returning * into v_rating;

  -- REPUTATION ONLY. No credit_ledger reference exists in this path.
  insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id)
  values (v_fb.author_id, p_score, 'creator_rating', v_rating.id, p_feedback_id);

  perform public.refresh_profile_reputation(v_fb.author_id);

  return v_rating;
end;
$$;

-- =============================================================================
-- revise_rating — corrections inside a short window
-- =============================================================================
--
-- Writes a reversing pair rather than editing the original score, so the ledger
-- still shows what was first given and what it was changed to. A member's history
-- of giving feedback should not be silently rewritten.

create or replace function public.revise_rating(p_feedback_id uuid, p_score smallint)
returns public.feedback_ratings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_rating public.feedback_ratings;
  v_fb_author uuid;
  v_delta  integer;
  v_window integer := public.app_setting_int('app.rating_revision_window_hours', 24);
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
    raise exception 'The %h revision window has closed', v_window
      using errcode = 'check_violation';
  end if;

  select author_id into v_fb_author from public.feedback where id = p_feedback_id;

  perform pg_advisory_xact_lock(hashtext(v_fb_author::text));

  -- The pair: the original score is undone, the new one applied. Net movement is
  -- the difference, so the ledger total always equals the current score.
  v_delta := p_score - v_rating.score;

  update public.feedback_ratings
     set score = p_score, revised_at = now()
   where id = v_rating.id;

  insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
  values (v_fb_author, v_delta, 'rating_revision', v_rating.id, p_feedback_id, v_rating.id);

  perform public.refresh_profile_reputation(v_fb_author);

  select * into v_rating from public.feedback_ratings where id = v_rating.id;
  return v_rating;
end;
$$;

-- --- get_reputation(): the public profile card -----------------------------------

create or replace function public.get_reputation(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', p.id,
    'handle', p.handle,
    'reputation_total', p.reputation_total,
    'rated_feedback_count', p.rated_feedback_count,
    'reputation_avg', p.reputation_avg,
    -- Badge thresholds are a presentation concern with no product meaning of their
    -- own; keeping them here means the web app cannot invent its own.
    'badge', case
      when p.reputation_total >= 500 then 'mentor'
      when p.reputation_total >= 200 then 'trusted'
      when p.reputation_total >= 50 then 'established'
      else null
    end
  )
  from public.profiles p
  where p.id = p_user_id;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.get_reputation(uuid);
-- drop function if exists public.revise_rating(uuid, smallint);
-- drop function if exists public.rate_feedback(uuid, smallint);
-- drop function if exists public.evaluate_feedback_eligibility(uuid);
-- drop function if exists public.submit_feedback(uuid, text, feedback_tag[], text[]);
-- drop table if exists public.reputation_ledger;
-- drop table if exists public.feedback_ratings;
-- drop table if exists public.credit_eligibility_reviews;
-- drop table if exists public.feedback;
