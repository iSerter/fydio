-- =============================================================================
-- T02 · 0002 — Invites, profiles, hashtags
-- =============================================================================
--
-- Identity, the tag vocabulary, and the first hard invariant: a profile carries
-- at most five hashtags.
--
-- ORDER MATTERS IN THIS FILE. `invites.invited_by` and `hashtags.created_by`
-- both reference `profiles`, and those are plain immediate FKs — a constraint
-- cannot be deferred past a table that does not exist yet. So the tables are
-- created parent-first: profiles, then what points at it. The functions come
-- last because they reference all of it.
--
-- WHY THE 5-TAG LIMIT IS A DEFERRED CONSTRAINT TRIGGER RATHER THAN A CHECK
-- `CHECK` cannot contain a subquery, so "no more than five rows may point at
-- this profile" is inexpressible as a constraint. The alternative — an advisory
-- lock plus a count at insert time — is racy under concurrency and raises a
-- different error from the one a bulk insert produces. Deferring to COMMIT is
-- what makes the rule checkable against the transaction's settled state: a
-- profile legitimately gains its tags in one statement, and only the final
-- count is meaningful.

-- --- Profiles: the public member identity -------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle extensions.citext not null unique,
  display_name text not null,
  bio text,

  avatar_path text,

  role profile_role not null default 'member',

  -- Reputation aggregates. Denormalised because every profile card reads them
  -- and recomputing a ledger sum per row is a query the feed cannot afford.
  -- `refresh_profile_reputation` (0006) is the only writer that may move them,
  -- enforced by the trigger below.
  --
  -- numeric(4,2), not the numeric(3,2) the task text suggested: three digits
  -- with two after the point overflows at 10.00, so a member rated 10/10 — a
  -- perfectly ordinary outcome — could not have their average stored at all.
  -- Verified against this stack: `select 10.00::numeric(3,2)` errors.
  reputation_total integer not null default 0,
  rated_feedback_count integer not null default 0,
  reputation_avg numeric(4,2),

  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  constraint profile_handle_format check (handle ~ '^[a-z0-9_]{3,30}$'),
  constraint profile_display_name_len check (char_length(display_name) between 1 and 80),
  -- An average is meaningless without the count it averages, and a count with no
  -- average is exactly what a fresh profile looks like.
  constraint profile_reputation_consistent check (
    (rated_feedback_count = 0 and reputation_avg is null) or
    (rated_feedback_count > 0 and reputation_avg is not null)
  )
);

create index profiles_role_idx on public.profiles (role);

-- Reputation is derived. A member who can `update` their own profile row — which
-- they must, to edit a bio — must not be able to write `reputation_total = 9999`.
-- Only a SECURITY DEFINER path may move these, and the only such path is the
-- refresh function in 0006.
create or replace function public.profiles_guard_reputation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.reputation_total is distinct from old.reputation_total
     or new.rated_feedback_count is distinct from old.rated_feedback_count
     or new.reputation_avg is distinct from old.reputation_avg then
    -- Allow the one legitimate writer: `refresh_profile_reputation` is SECURITY
    -- DEFINER, so it runs as the function owner and arrives here with
    -- `current_user = postgres`. A member's direct UPDATE arrives as
    -- `authenticated` and is refused.
    --
    -- `current_user` alone is the right test, and `session_user` would be actively
    -- wrong: after `SET ROLE authenticated` (which is how PostgREST and the test
    -- suite both act as a member) `session_user` is still the login role that
    -- connected — `postgres`, or `authenticator` in production. Checking it would
    -- let any member through.
    if current_user not in ('postgres', 'supabase_admin', 'service_role') then
      raise exception 'Reputation is derived from the ledger and cannot be set directly'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Nor may a member promote themselves. Role changes go through
  -- admin_set_role() (0010), which also guards the last-admin case.
  if new.role is distinct from old.role
     and coalesce(auth.uid() = old.id, false) then
    raise exception 'Only an admin can change a role' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- --- is_admin(): the RLS helper every policy leans on -------------------------
--
-- SECURITY DEFINER because it is called from inside policies on `profiles` and
-- on every other table, and a policy on `profiles` that queries `profiles` recurses
-- infinitely. Running it as the definer sidesteps that entirely.
--
-- `stable` so the planner can evaluate it once per statement rather than once
-- per row, which matters for a policy applied over a 180-row feed query.

create or replace function public.is_admin(p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = coalesce(p_user_id, auth.uid())
       and role = 'admin'
  );
$$;

create trigger profiles_guard_reputation_trg
  before update on public.profiles
  for each row execute function public.profiles_guard_reputation();

-- --- Hashtags: the shared vocabulary -----------------------------------------
--
-- One global pool. A hashtag is a slug without the leading `#`; `@fydio/domain`
-- normalises input the same way (strip `#`, lowercase), so `#Design` and
-- `design` cannot become two different tags in the pool.

create table public.hashtags (
  id uuid primary key default gen_random_uuid(),
  slug extensions.citext not null unique,
  label text not null,
  usage_count integer not null default 0,
  is_official boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint hashtag_slug_format check (slug ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$' and char_length(slug) <= 40),
  constraint hashtag_usage_non_negative check (usage_count >= 0)
);

-- --- profile_hashtags: up to five, the feed's primary signal ------------------

create table public.profile_hashtags (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  hashtag_id uuid not null references public.hashtags (id) on delete cascade,
  position smallint not null,

  primary key (profile_id, hashtag_id),

  constraint profile_hashtag_position_range check (position between 0 and 4)
);

create index profile_hashtags_hashtag_idx on public.profile_hashtags (hashtag_id);

-- THE FIVE-HASHTAG LIMIT. See the header for why this must be deferred to
-- COMMIT: the count is taken against settled rows, so a bulk insert of six
-- raises here rather than silently leaving a profile with six tags that would
-- then distort feed matching.
create or replace function public.enforce_profile_hashtag_limit()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cnt integer;
begin
  select count(*) into cnt
    from public.profile_hashtags
   where profile_id = new.profile_id;

  if cnt > 5 then
    raise exception 'Profile hashtag limit exceeded: % > 5', cnt
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create constraint trigger profile_hashtag_limit_trg
  after insert or update on public.profile_hashtags
  deferrable initially deferred
  for each row execute function public.enforce_profile_hashtag_limit();

-- --- profile_links: connected public handles ---------------------------------
--
-- Optional and read-only in practice: public URLs shown as "elsewhere", never
-- used for authentication. No constraint ties them to a member's identity,
-- deliberately — Fydio never asks anyone for a third-party credential.

create table public.profile_links (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  platform platform_kind not null,
  url text not null,
  label text,

  created_at timestamptz not null default now(),

  constraint profile_link_url_len check (char_length(url) between 4 and 500),
  constraint profile_link_label_len check (label is null or char_length(label) <= 60),

  -- At most one link per platform, so a profile card cannot show three TikTok
  -- handles and leave the reader guessing which is current.
  unique (profile_id, platform)
);

create index profile_links_profile_idx on public.profile_links (profile_id);

-- --- Invites: the gate --------------------------------------------------------
--
-- Invite-only is a product requirement ("private by default", brief §MVP), so the
-- schema admits only rows that represent a real invitation. `token_hash` rather
-- than `token`, so a leaked database does not hand over working invitations.

create table public.invites (
  id uuid primary key default gen_random_uuid(),

  -- citext: an invitation is an identity, and `Ada@x.com` inviting `ada@x.com`
  -- is the same person regardless of how they typed it.
  email extensions.citext not null unique,

  -- SHA-256 of the token, never the token itself.
  token_hash bytea not null unique,

  role profile_role not null default 'member',
  invited_by uuid references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,

  -- A revoked invitation is worse than none: it looks valid and then fails at
  -- redemption. Refuse the ambiguous state at write time.
  constraint invite_not_accepted_and_revoked check (not (accepted_at is not null and revoked_at is not null))
);

create index invites_email_idx on public.invites (email);

-- --- unique_handle_from_email(): handle allocation ----------------------------
--
-- Handle allocation is a uniqueness problem, not a formatting one: two members
-- can easily share an email local part. Rather than trusting an upstream counter
-- that a race would break, this retries against the unique index.

create or replace function public.unique_handle_from_email(p_email text)
returns extensions.citext
language plpgsql
set search_path = public
as $$
declare
  v_base text;
  v_try  text;
  v_n    integer := 1;
begin
  v_base := regexp_replace(
    lower(split_part(coalesce(p_email, ''), '@', 1)),
    '[^a-z0-9]+',
    '',
    'g'
  );

  -- The CHECK constraint requires 3+ characters; fall back when the local part is
  -- too short, or entirely punctuation, to survive sanitising.
  if char_length(v_base) < 3 then
    v_base := 'member';
  end if;

  v_base := left(v_base, 24);

  loop
    v_try := case when v_n = 1 then v_base else v_base || v_n::text end;

    exit when not exists (select 1 from public.profiles where handle = v_try);
    v_n := v_n + 1;
  end loop;

  return v_try;
end;
$$;

-- --- ensure_profile(): idempotent provisioning -------------------------------

create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.profiles;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.profiles where id = v_uid;

  if found then
    return v_row;
  end if;

  -- The trigger on auth.users normally creates this row at sign-up. This path
  -- exists for accounts that predate the trigger (a restored dump, rows inserted
  -- by an admin) and must produce the same shape rather than a second one.
  insert into public.profiles (id, handle, display_name)
  values (
    v_uid,
    public.unique_handle_from_email((select email from auth.users where id = v_uid)),
    coalesce(
      nullif((select raw_user_meta_data ->> 'display_name' from auth.users where id = v_uid), ''),
      'New member'
    )
  )
  on conflict (id) do nothing;

  select * into v_row from public.profiles where id = v_uid;
  return v_row;
end;
$$;

-- --- handle_new_user(): provision on first sign-in ---------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, handle, display_name, avatar_path)
  values (
    new.id,
    public.unique_handle_from_email(new.email),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'New member'
    ),
    nullif(new.raw_user_meta_data ->> 'avatar_path', '')
  )
  on conflict (id) do nothing;

  -- Consume an invite if one is outstanding. Marking it accepted here rather than
  -- in application code means an invitation cannot be redeemed twice even if the
  -- client retries.
  update public.invites
     set accepted_at = now()
   where lower(email) = lower(new.email)
     and accepted_at is null
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.handle_new_user();
-- drop function if exists public.ensure_profile();
-- drop function if exists public.unique_handle_from_email(text);
-- drop function if exists public.profiles_guard_reputation();
-- drop table if exists public.invites;
-- drop table if exists public.profile_links;
-- drop table if exists public.profile_hashtags;
-- drop table if exists public.hashtags;
-- drop table if exists public.profiles;
