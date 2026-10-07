-- =============================================================================
-- T08 · 0025 — Duration consent
-- =============================================================================
--
-- `duration_events` exists (0008) and 0008's `record_duration_event` accepts a
-- `p_consent_version` string and checks only that it is non-empty. That check is
-- the absence of a check: any member could POST `'anything'` and have a duration
-- event written for themselves. Consent that the client asserts is not consent,
-- it is a claim.
--
-- So this migration adds the table the claim can be checked against, and one
-- function that answers "does this member have an active, current grant" as a
-- fact.
--
-- THE CONSENT MODEL, STATED ONCE.
--
--   * Opt-in. No row means no.
--   * Per member. One row per member, updated in place — a member has one
--     relationship with this feature, not a history of relationships with it.
--   * Versioned. `consent_version` records WHICH text they agreed to. Bump
--     `current_duration_consent_version()` and every grant is stale, because the
--     grant was consent to words that have changed.
--   * Revocable, and revocation is a timestamp rather than a delete, so
--     "when did they turn it off" stays answerable.
--
-- WHY ONE ROW PER MEMBER AND NOT AN EVENT LOG. An append-only consent log is the
-- right shape for an audit trail that a regulator or a dispute will ask about.
-- This is not that: it is a control. The value of interest is "is consent active
-- right now", and a log answers that with a scan plus an interpretation rule,
-- where a row answers it with an index hit. The `granted_at`/`revoked_at`
-- timestamps keep the two facts a member might ask about — when did I turn this
-- on, when did I turn it off — without the machinery.

create table public.duration_consents (
  user_id uuid primary key references public.profiles (id) on delete cascade,

  -- The version of the consent text agreed to. Compared against
  -- `current_duration_consent_version()` on every read: a stale version is
  -- treated as no consent at all, which is what makes bumping the version a real
  -- re-prompt rather than a rename.
  consent_version text not null,

  granted_at timestamptz not null default now(),
  revoked_at timestamptz,

  -- Where the grant came from. `settings` is the web privacy panel; `extension`
  -- is the T10 consent screen. Kept because "I did not agree to that" and "I
  -- agreed somewhere I do not remember" are different problems to debug.
  source text not null default 'settings',

  constraint duration_consent_version_present check (char_length(consent_version) > 0),
  constraint duration_consent_known_source check (source in ('settings', 'extension')),
  -- A revoke cannot precede the grant it revokes. Without this, a bad write
  -- produces a permanently-revoked grant with no way to tell it from a real one.
  constraint duration_consent_revoke_after_grant check (
    revoked_at is null or revoked_at >= granted_at
  )
);

-- The privacy panel reads exactly one row per member by primary key, and the
-- consent gate inside the ingest RPC reads the same row. Both are index hits; the
-- index exists because the second one runs on every duration event.
create index duration_consents_active_idx
  on public.duration_consents (user_id)
  where revoked_at is null;

comment on table public.duration_consents is
  'Per-member opt-in for coarse duration telemetry. Absence of a row means no consent; a stale consent_version also means no consent.';

comment on column public.duration_consents.consent_version is
  'Which version of the consent text this member agreed to. Stale versions are treated as no consent.';

-- --- has_current_duration_consent -----------------------------------------------------------
--
-- THE GATE. One function, one question: may a duration event be recorded for this
-- member RIGHT NOW?
--
-- `stable` and `security definer` so it can be called from inside another
-- SECURITY DEFINER function without the caller's role mattering, and so the
-- answer cannot change mid-transaction.
--
-- SECURITY DEFINER IS A NECESSARY EVIL HERE, and the reason matters: this
-- function takes a `p_user_id` argument, and under RLS a member could only ever
-- ask about themselves — which would make the ingest path (a service-role job)
-- unable to ask about the member the extension is acting for. Definer + an
-- explicit EXECUTE policy below is the standard shape; what keeps it honest is
-- that this function RETURNS A BOOLEAN ABOUT CONSENT and nothing else. It is not a
-- read of anybody's data, so widening who may call it widens nothing.
--
-- The `p_version` argument is optional and defaults to the current version. That
-- default is what stops a caller from passing its own version string and thereby
-- deciding what "consent" means.
create or replace function public.has_current_duration_consent(
  p_user_id  uuid,
  p_version  text default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.duration_consents dc
     where dc.user_id = p_user_id
       and dc.revoked_at is null
       and dc.consent_version = coalesce(p_version, public.current_duration_consent_version())
  );
$$;

comment on function public.has_current_duration_consent(uuid, text) is
  'True when the member has an unrevoked grant at the current consent version. The gate every duration ingest checks.';

-- --- grant_duration_consent / revoke_duration_consent ----------------------------------------
--
-- Member-callable, caller-only, no arguments.
--
-- NO p_user_id ON PURPOSE. A grant function that took a user id would be a
-- self-service consent forge: `grant_duration_consent('<someone else>')` would
-- record consent that nobody gave. Taking the member from `auth.uid()` is what
-- makes the row mean anything.
--
-- The upsert on re-grant resets `revoked_at` and `granted_at` together. That is
-- the honest reading of "I turned it back on": the current grant starts now.
-- A member asking "when did I first consent" gets the answer from the duration
-- events themselves, which carry the consent version they were recorded under.

create or replace function public.grant_duration_consent(p_source text default 'settings')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_source not in ('settings', 'extension') then
    raise exception 'Unknown consent source: %', p_source using errcode = 'check_violation';
  end if;

  insert into public.duration_consents (user_id, consent_version, granted_at, revoked_at, source)
  values (auth.uid(), public.current_duration_consent_version(), now(), null, p_source)
  on conflict (user_id) do update
    set consent_version = excluded.consent_version,
        granted_at = excluded.granted_at,
        revoked_at = null,
        source = excluded.source;
end;
$$;

comment on function public.grant_duration_consent(text) is
  'Records the caller''s opt-in at the CURRENT consent version. Takes no user id: consent is only ever the caller''s own.';

create or replace function public.revoke_duration_consent()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revoked integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- `revoked_at is null` makes a second revoke a no-op rather than an error, and
  -- returns FALSE so the UI can say "already off" instead of failing.
  update public.duration_consents
     set revoked_at = now()
   where user_id = auth.uid()
     and revoked_at is null;

  get diagnostics v_revoked = row_count;

  return v_revoked > 0;
end;
$$;

comment on function public.revoke_duration_consent() is
  'Revokes the caller''s duration consent. Idempotent; returns whether this call was the one that revoked it.';

-- --- delete_own_duration_history ---------------------------------------------------------------
--
-- "Delete past records at any time" is a promise in the consent copy, so it has
-- to be a function rather than a UI affordance — otherwise the copy describes an
-- intention.
--
-- DELETES DURATION ROWS ONLY. `feed_impressions.opened` survives, and that is
-- deliberate: an open is the prerequisite `submit_feedback` already read, and
-- deleting it after the fact would retroactively invalidate feedback somebody
-- already wrote and possibly already earned a Credit for. Consent governs
-- telemetry; it does not rewrite history.
create or replace function public.delete_own_duration_history()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.duration_events where user_id = auth.uid();

  get diagnostics v_deleted = row_count;

  return v_deleted;
end;
$$;

comment on function public.delete_own_duration_history() is
  'Deletes the caller''s duration events. Opened history is untouched: it is already-acted-upon state, not telemetry.';

-- --- RLS -------------------------------------------------------------------------------------
--
-- FORCE, like `duration_events`. A `security definer` function writing this table
-- runs as the owner, and without FORCE the owner would bypass the policies — so
-- FORCE is what makes the policies below bind the RPCs too, not just the client.
--
-- SELECT-ONLY, SELF-ONLY. There is deliberately no INSERT/UPDATE policy: consent
-- is written exclusively by the two definer functions above, which check
-- `auth.uid()` themselves. A direct-write policy would be a second, weaker path to
-- the same row.
--
-- NO ADMIN READ POLICY. Same reasoning as 0009's `duration_events`: consent state
-- is private to the member. An admin who needs to answer "did this member
-- consent?" asks the member.
alter table public.duration_consents enable row level security;
alter table public.duration_consents force row level security;

create policy duration_consents_read_own on public.duration_consents
  for select to authenticated
  using (user_id = auth.uid());

-- --- Function privileges ------------------------------------------------------------------------
--
-- Same default-privileges trap as 0024: this image grants EXECUTE on every new
-- function to `anon`, `authenticated` and `service_role` at CREATE time, so the
-- revokes are load-bearing.
--
-- `has_current_duration_consent` is granted to `service_role` because the ingest
-- path is a job acting for a member it has already authenticated by extension
-- token. It is NOT granted to `authenticated`: a member has no reason to ask the
-- database whether someone ELSE consents, and the function takes a user id, so
-- leaving it member-callable would make the set of answerable questions larger
-- than it needs to be for no benefit. A member reads their OWN grant straight from
-- the table under the RLS policy above.
revoke execute on function public.has_current_duration_consent(uuid, text) from public;
revoke execute on function public.grant_duration_consent(text) from public;
revoke execute on function public.revoke_duration_consent() from public;
revoke execute on function public.delete_own_duration_history() from public;

grant execute on function public.grant_duration_consent(text) to authenticated;
grant execute on function public.revoke_duration_consent() to authenticated;
grant execute on function public.delete_own_duration_history() to authenticated;

grant execute on function public.has_current_duration_consent(uuid, text) to service_role;

revoke execute on function public.has_current_duration_consent(uuid, text) from anon;
revoke execute on function public.grant_duration_consent(text) from anon;
revoke execute on function public.revoke_duration_consent() from anon;
revoke execute on function public.delete_own_duration_history() from anon;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop table if exists public.duration_consents;
-- drop function if exists public.delete_own_duration_history();
-- drop function if exists public.revoke_duration_consent();
-- drop function if exists public.grant_duration_consent(text);
-- drop function if exists public.has_current_duration_consent(uuid, text);
-- =============================================================================
