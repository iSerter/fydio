-- =============================================================================
-- T08 · 0026 — Outbound click and the consented duration ingest
-- =============================================================================
--
-- 0008 shipped `record_outbound_click` and `record_duration_event`. Both are
-- replaced here, because both had the wrong SHAPE for what T08 needs:
--
--   * `record_outbound_click` returned the click row's id and derived
--     `return_token` from `sha256(user || entry || epoch)`. The return leg needs
--     the token itself (0024 established it as a random opaque value), and a
--     token derived from data the caller already knows is not a token.
--   * `record_duration_event` accepted a `p_consent_version` string and checked
--     only that it was non-empty. Consent is now a row (0025), so the check is a
--     fact about the member rather than a claim they made.
--
-- Neither replacement changes what a click MEANS. `opened` is still "this member
-- activated the link", which is a personal feed-history signal and not proof of
-- viewing, engagement, or credit eligibility.

-- --- Drop before replace ------------------------------------------------------------------------
--
-- `CREATE OR REPLACE` cannot change a function's RETURN TYPE (42P13), and
-- `record_outbound_click` goes from `uuid` to `table(click_id, return_token)`.
-- So the 0008 versions are dropped explicitly rather than replaced.
--
-- DROPPING IS SAFE HERE because nothing depends on either function: no view
-- references them, and the only callers are RPCs from the application, which are
-- redeclared below in the same transaction. Dropping also drops the EXECUTE
-- grants 0009 attached, which is why every grant is restated at the bottom —
-- without the restatement the functions would exist and be uncallable, which
-- presents as a permissions error rather than as a missing migration step.
--
-- `CASCADE` is deliberately NOT used. If something did depend on these, the
-- migration should fail loudly here rather than silently drop a dependent object.

drop function if exists public.record_outbound_click(uuid, text, text);
drop function if exists public.record_duration_event(uuid, duration_band, text, boolean);

-- --- record_outbound_click ---------------------------------------------------------------------
--
-- Records the click AND marks the entry opened in one call, and returns the
-- return token.
--
-- ONE CALL, NOT TWO. There is otherwise a window in which a click is recorded
-- but the entry is not marked, and `submit_feedback` requires the mark — so a
-- member who clicked in that window would be told their feedback was ineligible
-- for a reason that has nothing to do with their feedback.
--
-- THE TOKEN IS GENERATED HERE, NOT BY THE CALLER. Generating it in SQL means one
-- implementation of "unpredictable" (`gen_random_bytes`, 32 bytes) rather than
-- one in the database and one in TypeScript that could disagree about length or
-- encoding.
--
-- `opensslsl`-free: `extensions.gen_random_bytes` is pgcrypto's, which this
-- stack installed into the `extensions` schema (see the note in 0001 about why
-- functions qualify it explicitly instead of widening `search_path`).
--
-- The click id is still returned — alongside the token, as a composite — because
-- T09's metrics work wants "which click" and the return leg wants "which token",
-- and making two calls to get them would reintroduce the race above.

create or replace function public.record_outbound_click(
  p_entry_id uuid,
  p_client   text default null,
  p_source   text default null
) returns table (
  click_id uuid,
  return_token text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_click uuid;
  v_token text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Visibility check: active entries for anyone, author's own even when hidden.
  -- Matches mark_entry_opened so the RPC and the policies agree on visibility.
  if not exists (select 1 from public.content_entries where id = p_entry_id) then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if not public.can_view_entry(p_entry_id, v_uid) then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  -- 32 bytes → 64 hex characters → 256 bits of entropy. A return token is
  -- presented back to us in a URL, so it has to survive that unencoded; hex does.
  --
  -- Lowercase hex specifically: `outbound_clicks.return_token_idx` compares the
  -- stored text directly, and a case-sensitive mismatch would present as an
  -- "expired" link rather than as the bug it is.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.outbound_clicks (entry_id, user_id, client, source, return_token)
  values (p_entry_id, v_uid, p_client, p_source, v_token)
  returning id into v_click;

  -- Marks `feed_impressions.opened` for THIS member. Delegated to
  -- `mark_entry_opened` rather than re-implementing the upsert, so the "first
  -- open wins" rule lives in exactly one function.
  perform public.mark_entry_opened(p_entry_id);

  return query select v_click, v_token;
end;
$$;

comment on function public.record_outbound_click(uuid, text, text) is
  'Records an outbound click and marks the entry opened for the caller. Returns the click id and a per-viewer return token.';

-- --- record_duration_event (member path) ----------------------------------------------------------
--
-- Kept, and consent-gated. This is the path a member's own client uses when the
-- extension reports under their session rather than under an extension token,
-- and it now refuses without a current grant instead of accepting any version
-- string.
--
-- The gate is INSIDE the function rather than in the caller. A route that checked
-- consent and then called a function that did not would have two places to get
-- it wrong, and the second one would have no test.

create or replace function public.record_duration_event(
  p_entry_id        uuid,
  p_band            duration_band,
  p_consent_version text,
  p_returned        boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- The version argument is IGNORED for the decision, and that is the point. It
  -- is compared against the current version only to produce a precise error; a
  -- caller passing the right version without a grant still fails, and a caller
  -- passing the wrong version with a grant still fails, because the grant row is
  -- what is read.
  if not public.has_current_duration_consent(v_uid) then
    raise exception 'Duration tracking is not enabled for this member'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(nullif(trim(p_consent_version), ''), '') = '' then
    raise exception 'Duration telemetry requires explicit consent'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.duration_events (user_id, entry_id, band, returned, consent_version)
  values (v_uid, p_entry_id, p_band, coalesce(p_returned, false), public.current_duration_consent_version())
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_duration_event(uuid, duration_band, text, boolean) is
  'Records a coarse duration band for the CALLER, and only with an active current-version consent grant.';

-- --- ingest_duration_event (extension / service path) ---------------------------------------------
--
-- The T10 endpoint's way in. Three things it does that the member path cannot:
--
--   1. ACTS FOR A SPECIFIC MEMBER, chosen by the caller. Safe only because it is
--      `service_role`-only — see the grants at the bottom. The member was
--      identified by a scoped, expiring extension token upstream of the route.
--   2. ACCEPTS A `text` BAND AND CLAMPS IT. This is where "Fydio stores only the
--      band" stops being a convention. `p_band text` means an out-of-enum value
--      reaches this function as text rather than failing the cast, and the clamp
--      below turns it into `'unknown'`. Storing `'unknown'` is honest; storing
--      the number the caller sent would not be, and storing the raw string would
--      poison an enum column with data no reader can interpret.
--   3. WRITES THE CONSENT VERSION THE GATE ACTUALLY CHECKED. Not the version the
--      caller claimed. So every stored row says which text was in force at the
--      moment of the event, and an audit of "was this collected under consent"
--      is answerable from the row alone.

create or replace function public.ingest_duration_event(
  p_user_id  uuid,
  p_entry_id uuid,
  p_band     text,
  p_returned boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.has_current_duration_consent(p_user_id) then
    -- `42501` rather than a not-found: the caller is authenticated and asking
    -- about its own configured member, so "no" is the honest answer. A member
    -- could not reach this function regardless.
    raise exception 'Duration tracking is not enabled for this member'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.duration_events (user_id, entry_id, band, returned, consent_version)
  values (
    p_user_id,
    p_entry_id,
    -- The clamp. `p_band in (...)` over text, then the cast — so an unknown
    -- string lands on 'unknown' instead of raising and losing the event.
    case
      when p_band in ('lt_15s', 's15_60', 'm1_3', 'gt_3', 'unknown') then p_band::duration_band
      else 'unknown'::duration_band
    end,
    coalesce(p_returned, false),
    public.current_duration_consent_version()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.ingest_duration_event(uuid, uuid, text, boolean) is
  'Service-role duration ingest. Clamps any out-of-enum band to ''unknown'' and refuses without a current consent grant.';

-- --- The structural guard: no duration column ---------------------------------------------------
--
-- The acceptance criterion is that `duration_events` holds ONLY a band, and the
-- proof is a pgTAP assertion over `information_schema.columns` in
-- `010_telemetry.sql`: exactly these six columns, with `duration_ms` and every
-- other measurement-shaped name absent.
--
-- It is asserted rather than merely documented because a comment stops being
-- true the moment somebody adds a column, and this is the one invariant in T08
-- that a well-meaning future migration could plausibly break by adding a
-- convenience column.
comment on table public.duration_events is
  'Coarse active-tab duration bands, opt-in and viewer-private. There is deliberately NO duration_ms column: the band is the whole measurement.';

-- --- Function privileges -----------------------------------------------------------------------
--
-- `record_outbound_click` KEEPS its 0009 grants. It still takes the same
-- arguments; only the return type changed, so the signature-level grants from
-- 0009 (`to authenticated`) carry over. They are restated anyway because this
-- migration's whole subject is who may execute what, and a reader should not have
-- to check 0009 to know the current state.
--
-- `record_duration_event` likewise keeps `to authenticated` from 0009; its body
-- changed, not its signature.
--
-- `ingest_duration_event` is `service_role`-ONLY and is revoked from
-- `authenticated` explicitly. That revoke is the load-bearing part: this image's
-- default privileges grant EXECUTE on every new function to `authenticated` at
-- CREATE time, and this function takes an arbitrary `p_user_id`. Left granted, any
-- signed-in member could record a duration event against ANY other member — which
-- is forging somebody else's private history, the exact thing 0009's RLS exists
-- to prevent. It is revoked from `anon` for the same reason.
revoke execute on function public.record_outbound_click(uuid, text, text) from public;
revoke execute on function public.record_duration_event(uuid, duration_band, text, boolean) from public;
revoke execute on function public.ingest_duration_event(uuid, uuid, text, boolean) from public;

grant execute on function public.record_outbound_click(uuid, text, text) to authenticated;
grant execute on function public.record_duration_event(uuid, duration_band, text, boolean) to authenticated;
grant execute on function public.ingest_duration_event(uuid, uuid, text, boolean) to service_role;

revoke execute on function public.record_outbound_click(uuid, text, text) from anon;
revoke execute on function public.record_duration_event(uuid, duration_band, text, boolean) from anon;
revoke execute on function public.ingest_duration_event(uuid, uuid, text, boolean) from anon;

revoke execute on function public.ingest_duration_event(uuid, uuid, text, boolean) from authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.ingest_duration_event(uuid, uuid, text, boolean);
-- drop function if exists public.record_duration_event(uuid, duration_band, text, boolean);
-- drop function if exists public.record_outbound_click(uuid, text, text);
-- =============================================================================
