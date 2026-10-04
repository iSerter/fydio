-- =============================================================================
-- T03 · 0012 — Hashtag normalization, invite redemption, avatar storage
-- =============================================================================
--
-- Three things T03 needs that T02's schema deliberately left out:
--
--   1. the rules that turn typed text into a member of the shared vocabulary
--      (`normalize_hashtag`, `create_hashtag`, `set_profile_hashtags`);
--   2. the invite REDEMPTION path, gated on the token rather than on the email
--      (`claim_invite`), plus the two columns that path writes;
--   3. the `avatars` bucket and its RLS policies.
--
-- WHY THE TRIGGER'S EMAIL-BASED INVITE CONSUMPTION IS REMOVED HERE
-- T02's `handle_new_user` accepted any outstanding invite matching the new user's
-- email. That looked like a belt-and-braces replay guard, but it silently
-- contradicts token-gated redemption: the accept-invite route calls
-- `auth.admin.createUser` FIRST, which fires this trigger, which marks the invite
-- accepted -- so by the time `claim_invite` runs, its "already used" check has always
-- fired and redemption is effectively gated on *email possession* rather than on
-- *token possession*.
--
-- The brief's threat model is explicit: "The app stores only `token_hash`, so a
-- database leak cannot be replayed." That property only holds if the token is the
-- single authority on redemption. So the trigger keeps provisioning the profile row
-- and drops the invite UPDATE entirely, and `claim_invite` below is the one and only
-- way an invite becomes accepted.
--
-- WHY `hashtags.usage_count` IS A TRIGGER RATHER THAN A COLUMN A CALLER SETS
-- Usage count feeds the picker's suggestion ranking (`usage_count DESC`), which is how
-- a new member reaches a valid five-tag state in one pass. If callers maintained it,
-- the ranking would drift toward whoever cared to update it. Derived on write from
-- `content_hashtags` instead.
--
-- WHY THE CANONICAL SEPARATOR IS `-`
-- The vocabulary already contains hyphens (`hook-analysis`, `color-grading`), and
-- `@fydio/domain`'s `hashtagSchema` accepts both `-` and `_`. Collapsing everything to
-- one spelling means `snake_case` and `snake-case` are the same tag rather than two
-- entries that each look half-used. The `hashtags_slug_format` CHECK from 0002 permits
-- both separators, so nothing downstream needs changing.

-- --- Schema additions -----------------------------------------------------------

-- Who redeemed an invite. `set null` on delete: the audit fact "this invitation was
-- redeemed" outlives the account, and losing the row because a member deleted their
-- account would make a replayed token look merely expired.
alter table public.invites
  add column if not exists accepted_by uuid references public.profiles (id) on delete set null;

-- The onboarding gate.
--
-- `display_name` cannot serve as the signal the task text suggests: it is NOT NULL
-- with a CHECK requiring 1-80 characters, and `handle_new_user` fills in a placeholder
-- ('New member', or the email local part). So "display_name IS NULL" is unreachable by
-- construction and would silently never fire. This column is the real marker, and it
-- is NULL for exactly one population: accounts that have not finished the five-step
-- wizard.
alter table public.profiles
  add column if not exists onboarding_completed_at timestamptz;

-- Hashtag vocabulary tunables, installed as database defaults so a fresh database
-- behaves with sane policy before the application has connected to set them. Mirrors
-- the `do $$` block in 0001; see that file for why an absent GUC must fall back to the
-- documented default rather than disabling the cap.
do $$
declare
  defaults text[][] := array[
    array['app.hashtag_daily_creation_cap', '5'],
    array['app.friend_request_hourly_cap', '10']
  ];
  item text[];
begin
  foreach item slice 1 in array defaults loop
    perform set_config(item[1], item[2], false);
  end loop;
end;
$$;

-- --- normalize_hashtag(): typed text to one canonical slug ----------------------
--
-- IMMUTABLE so it is usable in indexes and generated columns if a later migration needs
-- it, and so the unit tests can call it without a session.
--
-- The output is guaranteed to satisfy `hashtags_slug_format` (0002) for any input that
-- survives the length checks, which is the property that lets `create_hashtag` rely on
-- that CHECK rather than re-validating.

create or replace function public.normalize_hashtag(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  if p_raw is null then
    raise exception 'Hashtag cannot be empty' using errcode = 'check_violation';
  end if;

  v := lower(btrim(p_raw));

  -- A leading `#` is presentation, never identity. Stripped before anything else so
  -- `#Design` and `design` cannot become two tags in the pool.
  v := regexp_replace(v, '^#+', '', 'g');

  -- Any run of characters that is not a letter, digit or separator becomes a single
  -- `-`. Substituting (rather than deleting, as the task text sketched) keeps words
  -- apart: `Color Grading` becomes `color-grading`, not `colorgrading`.
  v := regexp_replace(v, '[^a-z0-9_-]+', '-', 'g');

  -- One canonical separator, and never a doubled one: the CHECK rejects `a--b`.
  v := regexp_replace(v, '[-_]+', '-', 'g');

  -- Neither end may be a separator, also per the CHECK.
  v := regexp_replace(v, '^-+', '', 'g');
  v := regexp_replace(v, '-+$', '', 'g');

  -- Bounds are checked AFTER normalisation, not before. Measuring the raw input would
  -- reject `#` + 40 characters as too long when its slug is exactly 40, and would
  -- accept a 60-character string whose punctuation collapses to 12.
  if char_length(v) < 2 then
    raise exception 'Hashtag must be at least 2 characters' using errcode = 'check_violation';
  end if;

  if char_length(v) > 40 then
    raise exception 'Hashtag must be 40 characters or fewer' using errcode = 'check_violation';
  end if;

  return v;
end;
$$;

-- --- create_hashtag(): idempotent vocabulary growth -----------------------------
--
-- A SECURITY DEFINER path because 0009's `hashtags_admin_write` policy limits writes to
-- admins, and members must be able to add tags (the picker's "create" affordance). The
-- function itself is the gate.
--
-- IDEMPOTENT BY DESIGN: a normalized conflict returns the existing row instead of
-- raising. The picker calls this when a member confirms typed text, and a member
-- retyping a tag that already exists must receive that tag -- not an error they cannot
-- act on, and not a second row that fragments the vocabulary.

create or replace function public.create_hashtag(p_label text)
returns public.hashtags
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_slug  text;
  v_label text;
  v_row   public.hashtags;
  v_cap   integer;
  v_made  integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  v_slug := public.normalize_hashtag(p_label);
  v_label := nullif(btrim(p_label), '');

  -- Already in the vocabulary: hand it back. Checked BEFORE the daily cap, so retyping
  -- an existing tag never consumes a creation slot.
  select * into v_row from public.hashtags where slug = v_slug;

  if found then
    return v_row;
  end if;

  -- Vocabulary-spam cap. A 30-person community does not need 150 near-duplicate tags,
  -- and without a cap a member could exhaust the pool by typing plausible variants of
  -- every existing tag.
  v_cap := public.app_setting_int('app.hashtag_daily_creation_cap', 5);

  select count(*) into v_made
    from public.hashtags
   where created_by = v_uid
     and created_at >= date_trunc('day', now() at time zone 'utc');

  if v_made >= v_cap then
    raise exception 'You can create at most % new hashtags per day', v_cap
      using errcode = 'check_violation';
  end if;

  -- `is_official` is admin-only, and this function is the only path in, so the
  -- assignment cannot be reached by a member. Official tags sort first in the picker.
  insert into public.hashtags (slug, label, is_official, created_by)
  values (v_slug, coalesce(v_label, v_slug), public.is_admin(), v_uid)
  on conflict (slug) do nothing
  returning * into v_row;

  -- `on conflict do nothing` leaves v_row null when a concurrent writer won the race.
  -- Re-read so the caller always gets the canonical row.
  if v_row.id is null then
    select * into v_row from public.hashtags where slug = v_slug;
  end if;

  return v_row;
end;
$$;

-- --- set_profile_hashtags(): the five-tag swap, atomically ---------------------
--
-- Delete-then-insert inside ONE transaction rather than a series of separate
-- statements. Two reasons:
--
--   1. `enforce_profile_hashtag_limit` (0002) is a DEFERRABLE INITIALLY DEFERRED
--      constraint trigger, so it only observes settled rows at COMMIT. Removing one tag
--      and adding another in the same transaction is invisible to it -- which is exactly
--      why "swap a tag" works while "add a sixth" does not.
--   2. Between the delete and the insert there would be a window where the profile has
--      fewer than five tags. A concurrent reader -- the T07 feed -- would see a member
--      matching on four signals instead of five.

create or replace function public.set_profile_hashtags(p_hashtags uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  v_count := coalesce(array_length(p_hashtags, 1), 0);

  if v_count > 5 then
    raise exception 'A profile may have at most 5 hashtags' using errcode = 'check_violation';
  end if;

  delete from public.profile_hashtags where profile_id = v_uid;

  -- `distinct on (tag)` collapses a duplicated id while keeping the EARLIEST position,
  -- so `row_number` below yields a contiguous 0..n-1 range. The
  -- `profile_hashtag_position_range` CHECK (0-4) therefore holds for any input that
  -- passed the count guard above.
  insert into public.profile_hashtags (profile_id, hashtag_id, position)
  select v_uid, t.tag, row_number() over (order by t.ord) - 1
  from (
    select distinct on (u.tag) u.tag, u.ord
      from unnest(coalesce(p_hashtags, '{}'::uuid[])) with ordinality as u(tag, ord)
     order by u.tag, u.ord
  ) t;
end;
$$;

-- --- claim_invite(): the single authority on redemption ------------------------
--
-- Takes the SHA-256 hex digest of the raw token, never the token itself, so a caller
-- that logs its arguments cannot leak a working invitation. The row lock is what makes
-- redemption single-use under concurrency: two simultaneous redemptions of the same
-- token serialise here, and the loser sees `accepted_at IS NOT NULL` and is refused.
-- Without `for update`, both could read "unused" and both could proceed.

create or replace function public.claim_invite(p_token_hash text, p_user_id uuid)
returns public.invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
begin
  if p_user_id is null then
    raise exception 'Invalid invite' using errcode = 'no_data_found';
  end if;

  -- `decode` is a pg_catalog function and is therefore ALWAYS resolvable, which is what
  -- lets it stay unqualified under `search_path = public`. `extensions.digest` in the
  -- fixture above is the opposite case: pgcrypto lives in `extensions` on this stack,
  -- so that one MUST be schema-qualified. Getting the two backwards is a 42883 at
  -- redemption time, not at migration time.
  select * into v_invite
    from public.invites
   where token_hash = decode(p_token_hash, 'hex')
     for update;

  if not found then
    raise exception 'Invalid invite' using errcode = 'no_data_found';
  end if;

  if v_invite.revoked_at is not null then
    raise exception 'This invitation was revoked' using errcode = 'check_violation';
  end if;

  if v_invite.accepted_at is not null then
    raise exception 'This invitation has already been used' using errcode = 'unique_violation';
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at < now() then
    raise exception 'This invitation has expired' using errcode = 'check_violation';
  end if;

  update public.invites
     set accepted_at = now(),
         accepted_by = p_user_id
   where id = v_invite.id
  returning * into v_invite;

  -- The invitation carries the role, so an admin's invite is what makes the recipient an
  -- admin. Doing it here rather than in the trigger keeps the role tied to the token
  -- that authorised it.
  --
  -- `profiles_guard_reputation` (0002) also guards `role`: a member may not promote
  -- themselves. This write clears that check because the function is SECURITY DEFINER
  -- (so `current_user` is the owner, not `authenticated`) and because a service-role
  -- caller has no `auth.uid()` to match against the row.
  update public.profiles
     set role = v_invite.role
   where id = p_user_id;

  return v_invite;
end;
$$;

-- --- handle_new_user(): provision only, no invite consumption --------------------
--
-- Reduced from the T02 version. The profile INSERT is unchanged and still the reason a
-- member always has a row to attach data to; the invite UPDATE that followed it is
-- gone, for the reason in this file's header.

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

  -- NOTE: no invite consumption here. `claim_invite` is the only path that sets
  -- `invites.accepted_at`, which is what makes the stored `token_hash` -- rather than an
  -- email address -- the thing that must be kept secret.

  return new;
end;
$$;

-- --- usage_count: derived from content_hashtags ---------------------------------

create or replace function public.hashtag_usage_bump()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.hashtags set usage_count = usage_count + 1 where id = new.hashtag_id;
    return new;
  end if;

  -- `greatest(0, ...)` because `hashtag_usage_non_negative` is a CHECK, and deleting a
  -- row whose count was already decremented should not turn a correctness guard into a
  -- spurious error.
  update public.hashtags set usage_count = greatest(0, usage_count - 1) where id = old.hashtag_id;
  return old;
end;
$$;

drop trigger if exists content_hashtag_usage_trg on public.content_hashtags;

create trigger content_hashtag_usage_trg
  after insert or delete on public.content_hashtags
  for each row execute function public.hashtag_usage_bump();

-- The seed inserts `content_hashtags` directly, so this trigger now populates
-- `usage_count` during `db:reset` -- which is what the picker's `usage_count DESC`
-- ranking reads. Previously every seeded tag sat at 0.

-- =============================================================================
-- Avatar storage
-- =============================================================================
--
-- Bucket plus RLS policies, created in a migration rather than by hand so a fresh
-- environment -- CI, a new teammate, Coolify -- cannot come up without them.
--
-- PUBLIC READ, OWNER-FOLDER WRITE. The asymmetry is deliberate: a profile picture is
-- shown on other members' `/u/[handle]` pages, so read cannot be member-gated, while
-- write must not be. The path convention `{user_id}/{timestamp}.webp` is what makes the
-- write check below meaningful -- the first path segment IS the owner, so
-- `(storage.foldername(name))[1] = auth.uid()::text` is an ownership test rather than a
-- naming convention someone could route around.
--
-- The 5 MB `file_size_limit` is the pre-re-encode ceiling. `POST /api/profile/avatar`
-- rejects larger uploads before they reach Storage, and re-encodes to <=200 KB, so this
-- bound is a backstop against a direct Storage-API upload that bypassed the route rather
-- than the primary control.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read is public because the bucket itself is. Written as an explicit policy rather than
-- relying on `public = true` alone so the intent is greppable, and so turning the bucket
-- private later is a one-line change with the reader visible.
drop policy if exists "avatars are publicly readable" on storage.objects;

create policy "avatars are publicly readable"
  on storage.objects
  for select
  using (bucket_id = 'avatars');

-- Write is scoped to the member's OWN folder. Both directions are guarded: `using`
-- restricts which existing object may be replaced, `with check` restricts where a
-- replacement may land. Checking only `using` would let a member overwrite an object in
-- someone else's folder by naming it in the request.
drop policy if exists "members upload to their own avatar folder" on storage.objects;

create policy "members upload to their own avatar folder"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members update their own avatar" on storage.objects;

create policy "members update their own avatar"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Delete is needed because replacing an avatar orphans the previous object. The upload
-- route calls it after a successful replace, and it is scoped identically so a member
-- can only ever remove their own images.
drop policy if exists "members delete their own avatar" on storage.objects;

create policy "members delete their own avatar"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Placed last, and written out rather than inherited, for the reason 0009 spells out at
-- length: this Supabase image installs `alter default privileges ... grant all on
-- functions to anon`, so every function created above was granted to `anon` and to
-- `authenticated` at CREATE time. Omitting a revoke therefore does not mean "not
-- granted" -- it means "granted to every caller, including anon".
--
-- `claim_invite` is the one function granted to `service_role` and NOT to
-- `authenticated`: it marks an invitation accepted, and only the server-side
-- accept-invite route (which holds the service key) may do that. A member cannot redeem
-- their own token by calling it directly, because by the time they could, the account it
-- would attach to does not exist yet.

revoke execute on function public.normalize_hashtag(text) from public;
revoke execute on function public.normalize_hashtag(text) from anon;
revoke execute on function public.create_hashtag(text) from public;
revoke execute on function public.create_hashtag(text) from anon;
revoke execute on function public.set_profile_hashtags(uuid[]) from public;
revoke execute on function public.set_profile_hashtags(uuid[]) from anon;
revoke execute on function public.claim_invite(text, uuid) from public;
revoke execute on function public.claim_invite(text, uuid) from anon;

grant execute on function public.normalize_hashtag(text) to authenticated;
grant execute on function public.create_hashtag(text) to authenticated;
grant execute on function public.set_profile_hashtags(uuid[]) to authenticated;

grant execute on function public.claim_invite(text, uuid) to service_role;
revoke execute on function public.claim_invite(text, uuid) from authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop policy if exists "members delete their own avatar" on storage.objects;
-- drop policy if exists "members update their own avatar" on storage.objects;
-- drop policy if exists "members upload to their own avatar folder" on storage.objects;
-- drop policy if exists "avatars are publicly readable" on storage.objects;
-- delete from storage.buckets where id = 'avatars';
-- drop trigger if exists content_hashtag_usage_trg on public.content_hashtags;
-- drop function if exists public.hashtag_usage_bump();
-- drop function if exists public.claim_invite(text, uuid);
-- drop function if exists public.set_profile_hashtags(uuid[]);
-- drop function if exists public.create_hashtag(text);
-- drop function if exists public.normalize_hashtag(text);
-- alter table public.profiles drop column if exists onboarding_completed_at;
-- alter table public.invites drop column if exists accepted_by;
