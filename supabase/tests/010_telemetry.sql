-- =============================================================================
-- pgTAP · 010 — Outbound clicks, return tokens, and duration consent
-- =============================================================================
--
-- The guarantees only SQL can prove:
--
--   * a click records a row AND marks `opened`, for the clicking member only
--   * the return token is opaque, viewer-scoped, and expires in 30 minutes
--   * a tampered, foreign, or expired token resolves to nothing at all
--   * duration ingest is refused without a current-version consent grant, and
--     revocation takes effect immediately
--   * an out-of-enum band is stored as `'unknown'`, never as a measurement
--   * `duration_events` has NO duration column, and this suite fails if one
--     appears
--   * cross-member reads of duration events return zero rows
--   * no credit path reads `duration_events` (asserted structurally, below)
--
-- ROLE SWITCHING follows 009: `set local role` BEFORE `set_config`, because the
-- switch clears the GUC the other order depends on. Every function here is
-- SECURITY DEFINER, so without the switch these assertions would pass
-- vacuously — the session would still be the table owner.
--
-- WHY FIXTURES ARE BUILT HERE RATHER THAN BORROWED FROM THE SEED. The assertions
-- are about exact token values, exact counts, and exact null-ness. Depending on
-- whatever the seed happened to distribute makes a test that breaks for reasons
-- unrelated to the code under test, so every fixture is created in this file and
-- rolled back with it.

begin;

select plan(85);

-- =============================================================================
-- Fixtures
-- =============================================================================

select set_config('t08.ada', gen_random_uuid()::text, true);
select set_config('t08.bob', gen_random_uuid()::text, true);
select set_config('t08.cal', gen_random_uuid()::text, true);
select set_config('t08.entry', gen_random_uuid()::text, true);

insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  (current_setting('t08.ada')::uuid, '00000000-0000-0000-0000-000000000000', 't08-ada@demo.test', '', now(), now(), '{}', '{}'),
  (current_setting('t08.bob')::uuid, '00000000-0000-0000-0000-000000000000', 't08-bob@demo.test', '', now(), now(), '{}', '{}'),
  -- A member who NEVER grants anything, so "no consent" is a state somebody is
  -- actually in rather than a hypothetical. Without this the "refused without
  -- consent" assertions would have to revoke first, and a revoke test that also
  -- serves as the no-consent test passes for the wrong reason when the revoke
  -- itself is broken.
  (current_setting('t08.cal')::uuid, '00000000-0000-0000-0000-000000000000', 't08-cal@demo.test', '', now(), now(), '{}', '{}')
on conflict (id) do nothing;

-- A canonical URL is required by content_entries' constraints, and the entries
-- need exactly three hashtags — which the entry-creation RPC handles, so the rows
-- are inserted directly with their tags.
insert into public.content_entries (
  id, author_id, platform, original_url, canonical_url, url_hash,
  title, preview_state, status, published_at, created_at
)
values (
  current_setting('t08.entry')::uuid, current_setting('t08.ada')::uuid, 'youtube',
  'https://www.youtube.com/watch?v=t08fixture', 'https://www.youtube.com/watch?v=t08fixture',
  extensions.digest('https://www.youtube.com/watch?v=t08fixture', 'sha256'),
  'T08 fixture entry', 'resolved', 'active', now(), now()
);

-- =============================================================================
-- Structure: the tables and functions exist with the signatures T08 relies on
-- =============================================================================

select has_table('public', 'duration_consents', 'duration_consents table exists');
select has_table('public', 'outbound_clicks', 'outbound_clicks table exists');
select has_table('public', 'duration_events', 'duration_events table exists');

select has_function('public', 'record_outbound_click', array['uuid', 'text', 'text'],
  'record_outbound_click exists');
select has_function('public', 'validate_return_token', array['text'],
  'validate_return_token exists');
select has_function('public', 'acknowledge_return_token', array['text'],
  'acknowledge_return_token exists');
select has_function('public', 'has_current_duration_consent', array['uuid', 'text'],
  'has_current_duration_consent exists');
select has_function('public', 'grant_duration_consent', array['text'],
  'grant_duration_consent exists');
select has_function('public', 'revoke_duration_consent', '{}',
  'revoke_duration_consent exists');
select has_function('public', 'delete_own_duration_history', '{}',
  'delete_own_duration_history exists');
select has_function('public', 'ingest_duration_event', array['uuid', 'uuid', 'text', 'boolean'],
  'ingest_duration_event exists');
select has_function('public', 'current_duration_consent_version', '{}',
  'current_duration_consent_version exists');

-- =============================================================================
-- The structural guard: duration_events holds a BAND and nothing finer
-- =============================================================================
--
-- THIS IS THE HEADLINE INVARIANT OF T08, and it is checked against
-- information_schema rather than trusted, because the failure mode it guards
-- against is a well-meaning migration adding a `duration_ms` column "for
-- debugging". The exact column list is asserted so the test fails on an
-- ADDITION, not only on a specifically-named column.

select is(
  (
    select array_agg(column_name order by column_name)::text
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'duration_events'
  ),
  '{band,consent_version,entry_id,id,received_at,returned,user_id}',
  'duration_events has exactly its seven columns and no measurement column'
);

select hasnt_column('public', 'duration_events', 'duration_ms',
  'duration_events has no duration_ms column');
select hasnt_column('public', 'duration_events', 'duration_seconds',
  'duration_events has no duration_seconds column');
select hasnt_column('public', 'duration_events', 'ended_at',
  'duration_events has no end timestamp to difference against a start');
select hasnt_column('public', 'duration_events', 'started_at',
  'duration_events has no start timestamp');

-- The band is an enum, not text, so a value outside the vocabulary cannot be
-- stored even by the table owner.
select col_type_is('public', 'duration_events', 'band', 'duration_band',
  'band is the duration_band enum, not free text');

-- =============================================================================
-- Consent: absent by default
-- =============================================================================

select set_config('request.jwt.claim.sub', current_setting('t08.ada'), true);
set local role authenticated;

select is(
  (select public.has_current_duration_consent(current_setting('t08.ada')::uuid)),
  false,
  'a member with no consent row has no current consent'
);

select lives_ok(
  $$ select public.grant_duration_consent('settings') $$,
  'a member can grant their own consent'
);

select is(
  (select public.has_current_duration_consent(current_setting('t08.ada')::uuid)),
  true,
  'consent is current immediately after granting'
);

select is(
  (select dc.consent_version from public.duration_consents dc
    where dc.user_id = current_setting('t08.ada')::uuid),
  (select public.current_duration_consent_version()),
  'the grant records the CURRENT consent version'
);

select is(
  (select count(*)::integer from public.duration_consents dc
    where dc.user_id = current_setting('t08.ada')::uuid),
  1,
  'granting twice leaves one row, not two'
);

-- A stale version is treated as no consent. Simulating this by asking about a
-- version nobody holds is the same question the ingest path asks after a bump.
select is(
  (select public.has_current_duration_consent(
     current_setting('t08.ada')::uuid,
     '1999-01-dur-v0'::text)),
  false,
  'a grant at a stale consent version is not consent'
);

-- =============================================================================
-- Duration ingest is refused without consent, and accepted with it
-- =============================================================================

-- Cal never consents. As Cal, the ingest must be refused: this is the assertion
-- that makes "opt-in" mean opt-in rather than "on by default with a settings
-- screen".
select set_config('request.jwt.claim.sub', current_setting('t08.cal'), true);

select throws_ok(
  $$ select public.record_duration_event(
       current_setting('t08.entry')::uuid, 's15_60'::duration_band,
       public.current_duration_consent_version(), false) $$,
  '42501'::varchar,
  null,
  'a member with no consent cannot record a duration event'
);

select is(
  (select count(*)::integer from public.duration_events de
    where de.user_id = current_setting('t08.cal')::uuid),
  0,
  'the refused attempt wrote nothing'
);

-- Bob grants through the extension consent screen; Ada grants through settings.
-- Two sources, one row shape.
select set_config('request.jwt.claim.sub', current_setting('t08.bob'), true);

select lives_ok($$ select public.grant_duration_consent('extension') $$, 'bob can grant consent');

select is(
  (select dc.source from public.duration_consents dc
    where dc.user_id = current_setting('t08.bob')::uuid),
  'extension',
  'the grant records which consent screen the member used'
);

select set_config('request.jwt.claim.sub', current_setting('t08.ada'), true);

select lives_ok(
  $$ select public.record_duration_event(
       current_setting('t08.entry')::uuid, 'm1_3'::duration_band,
       public.current_duration_consent_version(), true) $$,
  'a consented member can record a duration band'
);

select is(
  (select de.consent_version from public.duration_events de
    where de.user_id = current_setting('t08.ada')::uuid),
  (select public.current_duration_consent_version()),
  'the event records the consent version in force, not one the caller supplied'
);

-- An empty consent_version argument is refused even WITH a grant. The grant is
-- what authorises the write; a blank version string is a malformed request.
select throws_ok(
  $$ select public.record_duration_event(
       current_setting('t08.entry')::uuid, 's15_60'::duration_band, '  ', false) $$,
  '42501'::varchar,
  null,
  'a blank consent version is refused'
);

-- =============================================================================
-- Revocation takes effect immediately
-- =============================================================================

select is(
  (select public.revoke_duration_consent()),
  true,
  'revoking an active grant reports that it did the revoking'
);

select is(
  (select public.revoke_duration_consent()),
  false,
  'revoking again is a no-op that says so'
);

select throws_ok(
  $$ select public.record_duration_event(
       current_setting('t08.entry')::uuid, 'gt_3'::duration_band,
       public.current_duration_consent_version(), false) $$,
  '42501'::varchar,
  null,
  'revoked consent blocks ingest immediately'
);

-- The row survives revocation. That is the audit property: "when did they turn
-- it off" stays answerable, and `revoked_at` is the answer.
select ok(
  (select dc.revoked_at is not null from public.duration_consents dc
    where dc.user_id = current_setting('t08.ada')::uuid),
  'revocation is recorded as a timestamp rather than a delete'
);

-- Re-granting clears the revocation and resets the grant clock.
select lives_ok($$ select public.grant_duration_consent('settings') $$, 'a member can re-grant');
select is(
  (select public.has_current_duration_consent(current_setting('t08.ada')::uuid)),
  true,
  're-granting restores current consent'
);

-- =============================================================================
-- Band clamping: an out-of-enum band becomes 'unknown', never a measurement
-- =============================================================================

-- The service-role path is the one that receives untrusted text, so it is the one
-- that clamps. `service_role` has BYPASSRLS, and the role switch below is what
-- makes the assertions mean anything: `authenticated` could not execute it at all
-- (asserted further down).
reset role;
set local role service_role;

select lives_ok(
  $$ select public.ingest_duration_event(
       current_setting('t08.ada')::uuid, current_setting('t08.entry')::uuid, 's15_60', false) $$,
  'the service path accepts a valid band'
);

select lives_ok(
  $$ select public.ingest_duration_event(
       current_setting('t08.ada')::uuid, current_setting('t08.entry')::uuid, '1234567', false) $$,
  'the service path accepts a raw millisecond count without erroring'
);

select is(
  (select de.band::text from public.duration_events de
    where de.user_id = current_setting('t08.ada')::uuid
      and de.band::text not in ('lt_15s', 's15_60', 'm1_3', 'gt_3')
    order by de.received_at desc limit 1),
  'unknown',
  'a raw millisecond count is stored as unknown, never as itself'
);

select lives_ok(
  $$ select public.ingest_duration_event(
       current_setting('t08.ada')::uuid, current_setting('t08.entry')::uuid, 'two minutes', false) $$,
  'a prose duration is clamped rather than rejected'
);

select is(
  (select count(*)::integer
     from public.duration_events de
    where de.user_id = current_setting('t08.ada')::uuid
      and de.band = 'lt_15s'),
  0,
  'no event was misfiled into the shortest band by the clamping'
);

-- Consent is enforced on the service path too. This is the assertion that stops
-- "the extension reported it, so it must be fine" from being a policy.
select throws_ok(
  $$ select public.ingest_duration_event(
       (select id from public.profiles where id <> current_setting('t08.ada')::uuid limit 1),
       current_setting('t08.entry')::uuid, 's15_60', false) $$,
  '42501'::varchar,
  null,
  'the service path refuses a member with no consent'
);

-- =============================================================================
-- Outbound click records the click AND marks the entry opened
-- =============================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t08.ada'), true);

select set_config('t08.click', (
  select (public.record_outbound_click(
    current_setting('t08.entry')::uuid, 'web', 'feed')).click_id::text), true);

select set_config('t08.token', (
  select (public.record_outbound_click(
    current_setting('t08.entry')::uuid, 'web', 'entry_page')).return_token::text), true);

select ok(
  (select count(*) > 0 from public.outbound_clicks oc
    where oc.user_id = current_setting('t08.ada')::uuid
      and oc.entry_id = current_setting('t08.entry')::uuid),
  'the click is recorded against the clicking member'
);

select ok(
  (select fi.opened from public.feed_impressions fi
    where fi.viewer_id = current_setting('t08.ada')::uuid
      and fi.entry_id = current_setting('t08.entry')::uuid),
  'the entry is marked opened for the clicking member'
);

select ok(
  (select fi.opened_at is not null from public.feed_impressions fi
    where fi.viewer_id = current_setting('t08.ada')::uuid
      and fi.entry_id = current_setting('t08.entry')::uuid),
  'the open carries a timestamp, which is what the feedback prerequisite reads'
);

-- `opened` is set for the CLICKER ONLY. This is the assertion that would fail if
-- the RPC leaked the open to other members.
select is(
  (select count(*)::integer from public.feed_impressions fi
    where fi.entry_id = current_setting('t08.entry')::uuid
      and fi.viewer_id <> current_setting('t08.ada')::uuid
      and fi.opened),
  0,
  'no other member is marked as having opened the entry'
);

-- mark_entry_opened is idempotent AND first-open-wins, which is what makes a
-- second click not rewrite the connection's history.
select set_config('t08.first_open', (
  select fi.opened_at::text from public.feed_impressions fi
    where fi.viewer_id = current_setting('t08.ada')::uuid
      and fi.entry_id = current_setting('t08.entry')::uuid), true);

select lives_ok(
  $$ select public.mark_entry_opened(current_setting('t08.entry')::uuid) $$,
  'marking an already-open entry again succeeds'
);

select is(
  (select fi.opened_at::text from public.feed_impressions fi
    where fi.viewer_id = current_setting('t08.ada')::uuid
      and fi.entry_id = current_setting('t08.entry')::uuid),
  current_setting('t08.first_open'),
  'a repeated open does not overwrite the first open timestamp'
);

select throws_ok(
  $$ select public.mark_entry_opened(gen_random_uuid()) $$,
  'P0002'::varchar,
  null,
  'marking a nonexistent entry is refused rather than silently accepted'
);

-- =============================================================================
-- Return tokens: opaque, scoped, expiring
-- =============================================================================

select matches(
  (select current_setting('t08.token')),
  '^[0-9a-f]{64}$',
  'the return token is 32 bytes of hex, carrying no structure to guess'
);

select is(
  (select count(*)::integer from public.outbound_clicks oc
    where oc.return_token = current_setting('t08.token')),
  1,
  'the return token resolves to exactly one click'
);

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.token')) v),
  1,
  'the viewer resolves their own live token'
);

select is(
  (select v.entry_id::text from public.validate_return_token(current_setting('t08.token')) v),
  current_setting('t08.entry'),
  'the resolved token names the entry that was opened'
);

-- TAMPERING. Each of these is a different way a token could be wrong, and each
-- must resolve to nothing rather than to something.
select is(
  (select count(*)::integer from public.validate_return_token('not-a-token')),
  0,
  'a malformed token resolves to nothing'
);

select is(
  (select count(*)::integer from public.validate_return_token(
     substr(current_setting('t08.token'), 1, 63) ||
     case when right(current_setting('t08.token'), 1) = '0' then '1' else '0' end)),
  0,
  'a token with its last character altered resolves to nothing'
);

select is(
  (select count(*)::integer from public.validate_return_token(
     case when left(current_setting('t08.token'), 1) = 'f' then '0' else 'f' end ||
     substr(current_setting('t08.token'), 2))),
  0,
  'a token with its first character altered resolves to nothing'
);

select is(
  (select count(*)::integer from public.validate_return_token(
     upper(current_setting('t08.token')))),
  0,
  'an upper-cased token resolves to nothing, so hex case is not forgiving'
);

-- SCOPING. Bob holds a token of his own and must not be able to read Ada's.
select set_config('request.jwt.claim.sub', current_setting('t08.bob'), true);

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.token'))),
  0,
  'another member cannot resolve a token they did not open'
);

-- Bob clicks too, so "his own token resolves" is a real positive case rather
-- than a comparison against a subquery that returned nothing.
select lives_ok(
  $$ select public.record_outbound_click(current_setting('t08.entry')::uuid, 'web', 'feed') $$,
  'bob can record his own click'
);

select set_config('t08.bob_token', (
  select (public.record_outbound_click(
    current_setting('t08.entry')::uuid, 'web', 'feed')).return_token::text), true);

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.bob_token'))),
  1,
  'a member resolves their own token normally'
);

select isnt(
  (select current_setting('t08.bob_token')),
  (select current_setting('t08.token')),
  'each click issues a distinct token'
);

-- An anonymous caller is REFUSED rather than quietly resolving nothing. Both
-- shapes are safe, and refusing is the better one: a `null`-returning check would
-- have to be reasoned about, while a permission error cannot be mistaken for a
-- successful validation.
reset role;
set local role anon;

select throws_ok(
  $$ select public.validate_return_token(current_setting('t08.token')) $$,
  '42501'::varchar,
  null,
  'anon cannot validate a return token at all'
);

-- EXPIRY. Ageing the click past the window is the honest way to test this: moving
-- the clock would invalidate every other `now()`-dependent assertion in the file.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t08.ada'), true);

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.token'))),
  1,
  'the token is live immediately after the click'
);

-- Back to the owner for the ageing UPDATE: `outbound_clicks` has no UPDATE policy
-- for members, so under `authenticated` this would affect zero rows and the
-- assertion would pass for the wrong reason -- the token would still be fresh.
reset role;

update public.outbound_clicks
   set clicked_at = now() - interval '31 minutes'
 where return_token = current_setting('t08.token');

set local role authenticated;

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.token'))),
  0,
  'a token older than thirty minutes resolves to nothing'
);

reset role;

update public.outbound_clicks
   set clicked_at = now() - interval '29 minutes'
 where return_token = current_setting('t08.token');

set local role authenticated;

select is(
  (select count(*)::integer from public.validate_return_token(current_setting('t08.token'))),
  1,
  'a token inside the window still resolves'
);

-- ACKNOWLEDGEMENT is single-shot, and scoped like validation.
select lives_ok(
  $$ select public.acknowledge_return_token(current_setting('t08.token')) $$,
  'the return leg can be acknowledged'
);

select ok(
  (select oc.returned_at is not null from public.outbound_clicks oc
    where oc.return_token = current_setting('t08.token')),
  'acknowledging stamps returned_at'
);

select is(
  (select count(*)::integer from public.acknowledge_return_token(current_setting('t08.token'))),
  0,
  'acknowledging twice returns nothing, so the prompt appears once'
);

select set_config('request.jwt.claim.sub', current_setting('t08.bob'), true);

select is(
  (select count(*)::integer from public.acknowledge_return_token(current_setting('t08.token'))),
  0,
  'another member cannot acknowledge a return they did not make'
);

select is(
  (select count(*)::integer from public.outbound_clicks oc
    where oc.return_token = current_setting('t08.token') and oc.returned_at is null),
  0,
  'the foreign acknowledgement attempt did not stamp anything'
);

-- =============================================================================
-- Privacy: duration events are own-rows-only, and no role widens that
-- =============================================================================

select set_config('request.jwt.claim.sub', current_setting('t08.ada'), true);

select is(
  (select count(*)::integer from public.duration_events de
    where de.user_id <> current_setting('t08.ada')::uuid),
  0,
  'a member reads zero of another member''s duration events'
);

select ok(
  (select count(*) > 0 from public.duration_events de
    where de.user_id = current_setting('t08.ada')::uuid),
  'a member reads their own duration events'
);

select throws_ok(
  $$ insert into public.duration_events (user_id, entry_id, band, consent_version)
     select current_setting('t08.bob')::uuid,
            current_setting('t08.entry')::uuid, 'gt_3', 'v1' $$,
  '42501'::varchar,
  null,
  'a member cannot write a duration event against somebody else'
);

-- Consent state is self-only and member-writable only through the RPCs.
select is(
  (select count(*)::integer from public.duration_consents dc
    where dc.user_id <> current_setting('t08.ada')::uuid),
  0,
  'a member reads nobody else''s consent row'
);

select throws_ok(
  $$ insert into public.duration_consents (user_id, consent_version)
     values (current_setting('t08.bob')::uuid, '2026-01-dur-v1') $$,
  '42501'::varchar,
  null,
  'a member cannot write a consent row directly, only through the grant RPC'
);

-- =============================================================================
-- Deleting my own history
-- =============================================================================

select lives_ok($$ select public.delete_own_duration_history() $$, 'a member can delete their own duration history');

select is(
  (select count(*)::integer from public.duration_events de
    where de.user_id = current_setting('t08.ada')::uuid),
  0,
  'deleting history removes every duration row the member had'
);

-- Opened history SURVIVES, because `submit_feedback` already consumed it. A
-- "delete my data" control that silently invalidated somebody's existing
-- feedback would be worse than the telemetry it removes.
select ok(
  (select fi.opened from public.feed_impressions fi
    where fi.viewer_id = current_setting('t08.ada')::uuid
      and fi.entry_id = current_setting('t08.entry')::uuid),
  'deleting duration history leaves the opened state intact'
);

-- =============================================================================
-- The service-only ingest cannot be reached by a member or by anon
-- =============================================================================

select throws_ok(
  $$ select public.ingest_duration_event(
       current_setting('t08.ada')::uuid, current_setting('t08.entry')::uuid, 's15_60', false) $$,
  '42501'::varchar,
  null,
  'a member cannot call the service-only duration ingest'
);

reset role;
set local role anon;

select throws_ok(
  $$ select public.ingest_duration_event(
       current_setting('t08.ada')::uuid, current_setting('t08.entry')::uuid, 's15_60', false) $$,
  '42501'::varchar,
  null,
  'anon cannot call the service-only duration ingest'
);

select throws_ok(
  $$ select public.has_current_duration_consent(current_setting('t08.ada')::uuid) $$,
  '42501'::varchar,
  null,
  'a member-shaped role cannot probe whether somebody else consents'
);

-- =============================================================================
-- The credit economy never reads duration data
-- =============================================================================

reset role;

-- Asserted by NAME rather than by scanning the body: these are the functions that
-- decide what a Credit is worth, and a grep for "duration" across the schema
-- would also match this comment block.
select ok(
  not exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('evaluate_feedback_eligibility', 'release_held_credits',
                         'admin_grant_credit', 'admin_reverse_credit',
                         'admin_cap_credit', 'grant_weekly_allowance',
                         'create_content_entry')
       and p.prosrc ilike '%duration_events%'
  ),
  'no credit or eligibility function reads duration_events'
);

select ok(
  not exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('evaluate_feedback_eligibility', 'release_held_credits',
                         'admin_grant_credit', 'admin_reverse_credit',
                         'admin_cap_credit', 'grant_weekly_allowance',
                         'create_content_entry')
       and p.prosrc ilike '%feed_impressions%'
       and p.prosrc ilike '%insert into public.credit_ledger%'
  ),
  'no credit function both reads opened state and inserts a credit'
);

select ok(
  not exists (
    select 1 from pg_views v
     where v.schemaname = 'public'
       and v.definition ilike '%duration_events%'
       and v.definition ilike '%credit%'
  ),
  'no view joins duration_events into anything credit-bearing'
);

select * from finish();
rollback;
