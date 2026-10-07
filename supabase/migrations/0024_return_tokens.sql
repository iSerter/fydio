-- =============================================================================
-- T08 · 0024 — Return tokens
-- =============================================================================
--
-- The outbound click already exists (0008) and so does `mark_entry_opened`
-- (0007). What 0008 does NOT have is the RETURN leg: a way for a member to come
-- back to the entry they just opened and be offered feedback on it, without
-- Fydio ever touching the destination URL.
--
-- WHY THE TOKEN IS A COLUMN AND NOT A SIGNATURE.
--
-- The task sketch proposes an HMAC over (user, entry, timestamp). The simpler
-- shape is a random, unguessable value stored against the click, and it is
-- better here for three reasons:
--
--   1. A signature over data the client already knows proves nothing extra. The
--      only unguessable input to an HMAC is the SECRET, so a self-contained token
--      is security-by-obscurity: change the algorithm and every live token
--      invalidates, with no way to tell a forgery from an expiry.
--   2. `validate_return_token` must be a `SECURITY DEFINER` function to be
--      callable through PostgREST at all, and a function that verifies an HMAC
--      needs the secret inside the database. That puts a signing key next to the
--      data it protects, which is strictly worse than a random row lookup.
--   3. The token is a RETURN CORRELATOR, not a bearer credential. It resolves
--      exactly one already-authorised fact ("this member opened this entry"),
--      and `validate_return_token` re-derives that fact from the row and then
--      checks `auth.uid()`. Forging one requires guessing 2^122 values.
--
-- So: opaque, random, single-use-in-practice (30-minute expiry), viewer-scoped.
-- The row it points at already knows who clicked, which is what the viewer scope
-- then confirms.
--
-- ONE CLICK, ONE TOKEN. The unique index below is what makes `validate_return_token`
-- able to say "exactly one click", and it also means re-clicking the same link
-- issues a fresh token rather than reusing one — so the newest open is the one
-- whose prompt the member gets.

alter table public.outbound_clicks
  add column if not exists returned_at timestamptz;

comment on column public.outbound_clicks.returned_at is
  'When this member returned to Fydio on the token leg. Set by acknowledge_return_token.';

comment on column public.outbound_clicks.return_token is
  'Opaque random return token (122 bits of entropy, hex). Resolves one outbound click; never a bearer credential.';

-- Partial rather than a bare unique index: `return_token` is nullable, and
-- several NULLs must not collide. More importantly this makes "find the click
-- for this token" an index probe instead of a sequential scan of a table that
-- grows with every click any member ever makes.
create unique index if not exists outbound_clicks_return_token_idx
  on public.outbound_clicks (return_token)
  where return_token is not null;

-- `validate_return_token` filters on (user_id, clicked_at) after the token probe,
-- so the expiry check gets its own index rather than relying on the token row.
create index if not exists outbound_clicks_user_recent_idx
  on public.outbound_clicks (user_id, clicked_at desc);

-- --- current_duration_consent_version -------------------------------------------------
--
-- The consent text is a version, and this is where the version lives.
--
-- The alternative — passing the version in from the application on every ingest —
-- lets a caller assert whatever string it likes, which means the consent gate
-- checks "did you tell me you have consent" rather than "do you have consent".
-- Reading the version from the database instead makes the gate a fact about the
-- member, not a claim they made about themselves.
--
-- Mirrored by `DURATION_CONSENT_VERSION` in `@fydio/domain`;
-- `010_telemetry.sql` asserts the two agree, so a bump in one place without the
-- other fails a test rather than silently invalidating every member's grant.
create or replace function public.current_duration_consent_version()
returns text
language sql
immutable
set search_path = public
as $$
  select '2026-01-dur-v1'::text;
$$;

comment on function public.current_duration_consent_version() is
  'The consent text members currently agree to. Bumping it invalidates prior grants and events until re-consent.';

-- --- validate_return_token --------------------------------------------------------------
--
-- Strict by construction. A token resolves to a row ONLY when all of these hold:
--
--   * the token exists at all (unknown -> zero rows)
--   * the row's `user_id` is the caller (someone else's -> zero rows)
--   * the click is recent (older than the window -> zero rows)
--
-- Returning a zero-row set rather than raising is deliberate: the route and the
-- page turn that into "this link has expired", which is the honest answer for all
-- three cases and tells an attacker probing tokens nothing about which condition
-- failed. An exception per failure mode would be a token oracle.
create or replace function public.validate_return_token(p_token text)
returns table (
  entry_id uuid,
  opened_at timestamptz,
  returned_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select oc.entry_id, oc.clicked_at, oc.returned_at
    from public.outbound_clicks oc
   where oc.return_token = p_token
     -- The viewer who opened it. Not `auth.uid() is not null and ...`: a null
     -- uid would make the comparison NULL, the row would not match, and the
     -- function would look identical to an unknown token rather than refusing.
     and oc.user_id = auth.uid()
     and oc.clicked_at > now() - make_interval(mins => 30)
   limit 1;
$$;

comment on function public.validate_return_token(text) is
  'Resolves a return token to the entry its viewer opened, or zero rows when unknown, someone else''s, or expired.';

-- --- acknowledge_return_token -----------------------------------------------------------
--
-- Marks the return leg as taken, and returns what the feedback prompt needs.
--
-- Separate from `validate_return_token` because validation happens on every poll
-- while the prompt should appear once. `security definer` with a `viewer_id =
-- auth.uid()` guard rather than a bare update, so the function cannot be used to
-- stamp somebody else's click as returned.
--
-- Idempotent by construction: the `returned_at is null` predicate means a second
-- call matches nothing and returns zero rows, and the page handles that by
-- rendering the prompt anyway — the member is here, which is the fact the prompt
-- is about.
create or replace function public.acknowledge_return_token(p_token text)
returns table (
  entry_id uuid,
  opened_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.outbound_clicks oc
     set returned_at = now()
   where oc.return_token = p_token
     and oc.user_id = auth.uid()
     and oc.clicked_at > now() - make_interval(mins => 30)
     and oc.returned_at is null
  returning oc.entry_id, oc.clicked_at;
end;
$$;

comment on function public.acknowledge_return_token(text) is
  'Stamps the return leg as taken for the calling viewer. Zero rows when already acknowledged, unknown, or expired.';

-- --- mark_entry_opened ---------------------------------------------------------------------
--
-- Redefined here for one reason: 0007's version inserts an impression for ANY
-- entry id that exists, including one the viewer is not allowed to see (hidden
-- or removed, authored by someone else). The impression FK accepts it, so the
-- only thing standing between a member and an open-history row for a post they
-- cannot see was a route-level check.
--
-- Visibility is now part of the invariant. `can_view_entry` already encodes the
-- product rule (active entries for anyone; your own even when hidden) and is used
-- by the RLS policies, so reusing it means the RPC and the policies cannot
-- disagree about what "visible" means.
--
-- Everything else is 0007's behaviour, preserved deliberately: the FIRST open
-- wins via `coalesce(opened_at, ...)`, because `opened_at` is what
-- `submit_feedback`'s prerequisite and the "you opened this" history read.
create or replace function public.mark_entry_opened(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.content_entries where id = p_entry_id) then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if not public.can_view_entry(p_entry_id, auth.uid()) then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  insert into public.feed_impressions (entry_id, viewer_id, opened, opened_at, served_at)
  values (p_entry_id, auth.uid(), true, now(), now())
  on conflict (viewer_id, entry_id) do update
    set opened = true,
        opened_at = coalesce(public.feed_impressions.opened_at, excluded.opened_at);
end;
$$;

-- Function privileges. Every SECURITY DEFINER function above runs as its owner
-- and bypasses RLS, so the EXECUTE grant IS the access-control surface — and this
-- stack's default privileges hand EXECUTE on every new function to `anon`,
-- `authenticated` and `service_role` at CREATE time (see the note in 0009). So
-- each revoke-then-grant below is load-bearing, not decoration.
revoke execute on function public.validate_return_token(text) from public;
revoke execute on function public.acknowledge_return_token(text) from public;
revoke execute on function public.current_duration_consent_version() from public;

-- Read-only by construction: `validate_return_token` cannot write anything, and
-- `current_duration_consent_version` is immutable SQL.
grant execute on function public.validate_return_token(text) to authenticated;
grant execute on function public.acknowledge_return_token(text) to authenticated;

-- The consent version is read by the ingest route's own version check (below in
-- 0025) through the service client, and by pgTAP. It reveals nothing about any
-- member, so `service_role` gets it too.
grant execute on function public.current_duration_consent_version() to service_role;

-- `anon` explicitly. `revoke ... from public` removes the PUBLIC grant but this
-- image ALSO granted `anon` by name at CREATE time, and 004_rls.sql asserts anon
-- cannot reach a member surface.
revoke execute on function public.validate_return_token(text) from anon;
revoke execute on function public.acknowledge_return_token(text) from anon;
revoke execute on function public.current_duration_consent_version() from anon;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop index if exists public.outbound_clicks_user_recent_idx;
-- drop index if exists public.outbound_clicks_return_token_idx;
-- alter table public.outbound_clicks drop column if exists returned_at;
-- drop function if exists public.mark_entry_opened(uuid);
-- drop function if exists public.acknowledge_return_token(text);
-- drop function if exists public.validate_return_token(text);
-- drop function if exists public.current_duration_consent_version();
-- =============================================================================
