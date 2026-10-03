-- =============================================================================
-- pgTAP · 004 — Row level security
-- =============================================================================
--
-- RLS is the thing that makes the privacy promises in the brief true rather than
-- aspirational: credit balances stay private, duration telemetry stays with the
-- member who produced it, and nobody can promote themselves.
--
-- HOW THESE TESTS WORK. Each block does:
--
--   set local role authenticated   -- act as a signed-in member
--   set_config('request.jwt.claim.sub', <uuid>, true)
--
-- The role switch is what activates the policies; the GUC is what `auth.uid()`
-- reads. Both are transaction-local, so the file's ROLLBACK restores everything and
-- no test can leak identity into the next.
--
-- `set_config(..., true)` is scoped to the transaction, and `set role` does NOT
-- clear it -- verified against this stack rather than assumed, because the two
-- orderings fail in confusingly similar ways.

begin;

select plan(20);

create temporary table fx (
  id   integer primary key default 1 check (id = 1),
  ada  uuid not null,
  bob  uuid not null
) on commit drop;

-- BOTH members are ordinary members, deliberately.
--
-- The first draft of this file used the admin as "ada", which quietly passed nothing:
-- `credit_ledger_admin_all` is `using (public.is_admin())`, so an admin sees every row
-- and can write the ledger. Every assertion below would have failed for the wrong
-- reason, and the cross-member denials -- the entire point of the suite -- were not
-- being tested at all.
--
-- Admin reach is asserted separately, at the bottom, as its own property.
insert into fx (ada, bob)
select
  (select id from public.profiles where role <> 'admin' order by handle limit 1),
  (select id from public.profiles where role <> 'admin' order by handle offset 1 limit 1);

grant select on fx to authenticated;

-- Seed both members' private data so there is something to be denied.
insert into public.credit_ledger (user_id, delta, kind, status, note)
select id, 5, 'admin_grant', 'available', 'rls test' from public.profiles;

insert into public.outbound_clicks (entry_id, user_id, client, source)
select (select id from public.content_entries limit 1), id, 'web', 'test'
  from public.profiles;

-- =============================================================================
-- Every table has RLS enabled
-- =============================================================================

select is(
  (
    select count(*)::integer
      from pg_tables
     where schemaname = 'public'
       and tablename not in ('fx')
       and rowsecurity = false
  ),
  0,
  'every table in public has RLS enabled'
);

-- =============================================================================
-- Credit privacy — the headline promise
-- =============================================================================

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select is(
  (select count(*)::integer from public.credit_ledger where user_id <> (select ada from fx)),
  0,
  'a member cannot read another member credit rows'
);

select ok(
  (select count(*) > 0 from public.credit_ledger where user_id = (select ada from fx)),
  'a member can read their own credit rows'
);

-- And the sanctioned accessor refuses a cross-member question even though it is
-- SECURITY DEFINER and could technically read anything.
select throws_ok(
  $$ select public.get_credit_balance((select bob from fx)) $$,
  '42501'::varchar,
  null,
  'get_credit_balance refuses another member balance'
);

-- A member may not write the ledger directly: Credits come only from the RPCs.
select throws_ok(
  $$ insert into public.credit_ledger (user_id, delta, kind, status)
     select (select ada from fx), 999, 'admin_grant', 'available' $$,
  '42501'::varchar,
  null,
  'a member cannot insert a credit directly'
);

-- =============================================================================
-- Duration telemetry is private to its author
-- =============================================================================

select is(
  (select count(*)::integer from public.duration_events where user_id <> (select ada from fx)),
  0,
  'a member cannot read another member duration events'
);

select throws_ok(
  $$ insert into public.duration_events (user_id, entry_id, band, consent_version)
     select (select bob from fx),
            (select id from public.content_entries limit 1),
            's15_60', 'v1' $$,
  '42501'::varchar,
  null,
  'a member cannot forge duration events for someone else'
);

-- =============================================================================
-- The moderation audit trail is invisible to members entirely
-- =============================================================================

-- Written as the owner, which requires dropping back out of `authenticated` first.
-- Under that role this insert is exactly what the table forbids — which is the
-- property the assertion immediately below checks.
reset role;

insert into public.moderation_actions (actor_id, action, target_type, target_id)
select (select ada from fx), 'test', 'user', (select bob::text from fx);

set local role authenticated;

select is(
  (select count(*)::integer from public.moderation_actions),
  0,
  'a member reads zero moderation actions'
);

-- =============================================================================
-- Self-promotion is refused
-- =============================================================================

select throws_ok(
  $$ update public.profiles set role = 'admin' where id = (select ada from fx) $$,
  '42501'::varchar,
  null,
  'a member cannot promote themselves'
);

-- =============================================================================
-- Job RPCs are not member-callable
-- =============================================================================
--
-- The review window in brief §9 only means something if a member cannot release
-- their own held Credits early.

select throws_ok(
  $$ select public.release_held_credits() $$,
  '42501'::varchar,
  null,
  'a member cannot run the credit sweeper'
);

select throws_ok(
  $$ select public.grant_weekly_allowance(1000) $$,
  '42501'::varchar,
  null,
  'a member cannot grant themselves a weekly allowance'
);

select throws_ok(
  $$ select public.admin_grant_credit((select bob from fx), 1000, 'self service') $$,
  '42501'::varchar,
  null,
  'a non-admin cannot call the admin credit RPC'
);

-- =============================================================================
-- anon can reach nothing
-- =============================================================================

-- `anon` needs to read the fixture too, for the same reason `authenticated` does.
-- Without this the block fails on the fixture lookup before reaching the RLS logic it
-- exists to test.
--
-- `reset role` comes FIRST: the session is `authenticated` here, and only the owner
-- can grant on the temp table. Granting as `authenticated` is a silent no-op that
-- only surfaces later as a permission error on the read.
reset role;
grant select on fx to anon;

set local role anon;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select is(
  (select count(*)::integer from public.credit_ledger),
  0,
  'anon reads zero credit rows'
);

select is(
  (select count(*)::integer from public.profiles),
  0,
  'anon reads zero profiles'
);

select throws_ok(
  $$ select public.create_content_entry('youtube','https://a.test/1','https://a.test/1',
       (select array_agg(id) from public.hashtags limit 3)) $$,
  '42501'::varchar,
  null,
  'anon cannot call create_content_entry'
);

select throws_ok(
  $$ select public.get_credit_balance((select ada from fx)) $$,
  '42501'::varchar,
  null,
  'anon cannot read a balance through the RPC'
);

reset role;

-- =============================================================================
-- service_role bypasses, as designed
-- =============================================================================

set local role service_role;

select ok(
  (select count(*) > 0 from public.credit_ledger),
  'service_role bypasses RLS on the credit ledger'
);

reset role;

-- =============================================================================
-- Admin reach, asserted as its own property
-- =============================================================================
--
-- The fixture members above are both ordinary, so nothing so far has checked that
-- the admin policies work at all. An RLS suite that never exercises its own escape
-- hatch cannot tell a working admin policy from a missing one.

set local role authenticated;
select set_config('request.jwt.claim.sub',
  (select id::text from public.profiles where role = 'admin' limit 1), true);

select ok(
  (select count(*) > 0 from public.credit_ledger where user_id <> auth.uid()),
  'an admin can read another member credit rows'
);

select ok(
  (select count(*) > 0 from public.moderation_actions),
  'an admin can read the moderation audit trail'
);

select is(
  (select public.get_credit_balance((select bob from fx))),
  (select public.get_credit_balance((select bob from fx))),
  'an admin can read any balance through the RPC'
);

select * from finish();
rollback;
