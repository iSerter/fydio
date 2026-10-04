-- =============================================================================
-- pgTAP · 006 — Entry lifecycle (hashtag swap, edit, hide/unhide, remove)
-- =============================================================================
--
-- `create_content_entry` (0005) spends the Credit and publishes the row; 0014
-- adds the rest of the lifecycle. This suite proves:
--
--   * retagging swaps the set atomically and keeps exactly three tags
--   * two tags, duplicated tags, and unknown tags are all refused
--   * editing the note / feedback flag works, overlong notes do not
--   * hide/unhide flip visibility, remove is terminal with deleted_at set
--   * NONE of hide/unhide/remove moves a single ledger row (no refund path)
--   * a non-author cannot hide or edit someone else's entry
--   * the per-author duplicate-URL rule and the no-credits rule still hold
--
-- ROLE SWITCHING follows 002_credits.sql: `set local role` first, then
-- `set_config('request.jwt.claim.sub', ...)` — the switch clears GUC state, so
-- the reverse order loses the identity. `reset role` returns to postgres for
-- the direct-table assertions (RLS would filter them as a member).

begin;

select plan(39);

-- =============================================================================
-- Functions and storage exist
-- =============================================================================

select has_function('public', 'set_entry_hashtags', array['uuid', 'uuid[]'],
  'set_entry_hashtags exists');
select has_function('public', 'update_entry', array['uuid', 'text', 'boolean'],
  'update_entry exists');
select has_function('public', 'hide_entry', array['uuid'],
  'hide_entry exists');
select has_function('public', 'unhide_entry', array['uuid'],
  'unhide_entry exists');
select has_function('public', 'remove_entry', array['uuid'],
  'remove_entry exists');

select has_table('storage', 'buckets', 'storage buckets table exists');

select ok(
  (select count(*)::integer from storage.buckets where id = 'covers') = 1,
  'the covers bucket exists'
);

select ok(
  (select count(*)::integer from pg_policies
    where schemaname = 'storage' and policyname = 'members upload to own cover folder') = 1,
  'cover writes are policy-scoped to the owner folder'
);

-- =============================================================================
-- Fixture
-- =============================================================================
--
-- Ada is the admin (so the author-or-admin paths are hers), Bob an ordinary
-- member (so the cross-member denials mean something). Two disjoint tag sets of
-- three so the swap test moves to tags the entry does not already carry.

create temporary table fx (
  id       integer primary key default 1 check (id = 1),
  ada      uuid not null,
  bob      uuid not null,
  tags     uuid[] not null,
  tags2    uuid[] not null,
  entry_id uuid
) on commit drop;

create temporary table ledger_mark (
  n integer not null
) on commit drop;

insert into fx (ada, bob, tags, tags2)
select
  (select id from public.profiles where role = 'admin' order by handle limit 1),
  (select id from public.profiles where role <> 'admin' order by handle limit 1),
  (select array_agg(id) from (select id from public.hashtags order by slug limit 3) t),
  (select array_agg(id) from (select id from public.hashtags order by slug offset 3 limit 3) t);

-- `authenticated` reads the fixture inside every RPC call below. Without this
-- the calls fail with "permission denied for table fx" before reaching the
-- function body -- the same gotcha 002 documents.
grant select on fx to authenticated;

select is(
  (select count(*)::integer from fx), 1,
  'fixtures built from the seeded data'
);

-- Absolute-balance assertions need a clean ledger, and the rate cap in
-- `create_content_entry` must not mask the credit assertions -- same reasoning
-- as 002, same 400-day ageing.
delete from public.credit_ledger
 where user_id in (select ada from fx) or user_id in (select bob from fx);

update public.profiles
   set created_at = now() - interval '400 days'
 where id in (select ada from fx) or id in (select bob from fx);

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
select set_config('request.jwt.claim.email', 'ada@demo.test', true);

select is(
  (select public.get_credit_balance(bob) from fx), 0,
  'bob starts with a zero balance'
);

-- A member with no credits cannot submit: the spend guard fires first.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/t04-none', 'https://x.test/t04-none', tags) from fx $$,
  '23514'::varchar,
  null,
  'a member with no credits cannot submit'
);

reset role;

-- Give Ada exactly 3 credits so the spend below is statable.
insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, 3, 'admin_grant', 'available', 'test grant' from fx;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/t04-main', 'https://x.test/t04-main', tags) from fx $$,
  'a member with credits can submit'
);

reset role;

update fx set entry_id =
  (select id from public.content_entries
    where author_id = (select ada from fx)
      and canonical_url = 'https://x.test/t04-main');

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select is(
  (select public.get_credit_balance(ada) from fx), 2,
  'the submission cost exactly one credit'
);

-- =============================================================================
-- set_entry_hashtags: the three-tag swap
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.set_entry_hashtags(entry_id, tags2) from fx $$,
  'the author can swap the entry hashtag set'
);

-- Force the DEFERRED exactly-three trigger to fire now. Without this the check
-- would sit pending until the file's ROLLBACK and the count below would pass
-- without testing anything -- the technique 002 documents.
set constraints all immediate;

select is(
  (select count(*)::integer from public.content_hashtags where content_entry_id = (select entry_id from fx)),
  3,
  'the swapped set is still exactly three hashtags'
);

select throws_ok(
  $$ select public.set_entry_hashtags(entry_id, (select tags2[1:2] from fx)) from fx $$,
  '23514'::varchar,
  null,
  'two hashtags are refused'
);

select throws_ok(
  $$ select public.set_entry_hashtags(entry_id, (select array[tags2[1], tags2[1], tags2[1]] from fx)) from fx $$,
  '23514'::varchar,
  null,
  'three copies of one hashtag are refused'
);

select throws_ok(
  $$ select public.set_entry_hashtags(entry_id, (select tags2[1:2] || gen_random_uuid() from fx)) from fx $$,
  '23503'::varchar,
  null,
  'an unknown hashtag is refused'
);

-- =============================================================================
-- update_entry: note + feedback flag
-- =============================================================================

select lives_ok(
  $$ select public.update_entry(entry_id, 'Great pacing notes welcome', true) from fx $$,
  'the author can edit the note and feedback flag'
);

reset role;

select is(
  (select creator_note from public.content_entries where id = (select entry_id from fx)),
  'Great pacing notes welcome',
  'the creator note was stored'
);

select is(
  (select asks_for_feedback from public.content_entries where id = (select entry_id from fx)),
  true,
  'the feedback flag was stored'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select throws_ok(
  $$ select public.update_entry(entry_id, repeat('x', 1001), null) from fx $$,
  '23514'::varchar,
  null,
  'an overlong creator note is refused rather than truncated'
);

select lives_ok(
  $$ select public.update_entry(entry_id, '', null) from fx $$,
  'clearing the note with an empty string works'
);

reset role;

select is(
  (select creator_note from public.content_entries where id = (select entry_id from fx)),
  null,
  'the cleared note reads back as null'
);

-- Snapshot the author's ledger: nothing from here on may move it.
insert into ledger_mark
select count(*)::integer from public.credit_ledger where user_id = (select ada from fx);

-- =============================================================================
-- hide / unhide: visibility without ledger movement
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.hide_entry(entry_id) from fx $$,
  'the author can hide their entry'
);

reset role;

select is(
  (select status::text from public.content_entries where id = (select entry_id from fx)),
  'hidden',
  'hiding sets the status to hidden'
);

select is(
  (select count(*)::integer from public.credit_ledger where user_id = (select ada from fx)),
  (select n from ledger_mark),
  'hiding moves no credits'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.unhide_entry(entry_id) from fx $$,
  'the author can undo the hide'
);

reset role;

select is(
  (select status::text from public.content_entries where id = (select entry_id from fx)),
  'active',
  'unhiding restores the active status'
);

-- =============================================================================
-- remove: terminal, audit row retained, still no refund
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.remove_entry(entry_id) from fx $$,
  'the author can remove their entry'
);

reset role;

select is(
  (select status::text from public.content_entries where id = (select entry_id from fx)),
  'removed',
  'removing sets the status to removed'
);

select ok(
  (select deleted_at is not null from public.content_entries where id = (select entry_id from fx)),
  'removing stamps deleted_at'
);

select is(
  (select count(*)::integer from public.credit_ledger where user_id = (select ada from fx)),
  (select n from ledger_mark),
  'removing refunds nothing'
);

-- A removed entry cannot be hidden back into the lifecycle.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select throws_ok(
  $$ select public.hide_entry(entry_id) from fx $$,
  '23514'::varchar,
  null,
  'a removed entry cannot be hidden'
);

-- =============================================================================
-- A non-author reaches nothing
-- =============================================================================

select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

select throws_ok(
  $$ select public.hide_entry(entry_id) from fx $$,
  '42501'::varchar,
  null,
  'a non-author cannot hide someone elses entry'
);

select throws_ok(
  $$ select public.update_entry(entry_id, 'hijacked', null) from fx $$,
  '42501'::varchar,
  null,
  'a non-author cannot edit someone elses entry'
);

-- The per-author duplicate-URL rule still holds: the removed row keeps its
-- hash, so resubmitting the same URL is a second submission of one URL.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/t04-main', 'https://x.test/t04-main', tags) from fx $$,
  '23505'::varchar,
  null,
  'the same URL cannot be submitted twice by one author'
);

reset role;

select is(
  (select count(*)::integer
     from (select ch.content_entry_id
             from public.content_hashtags ch
            group by ch.content_entry_id
           having count(*) = 3) ok),
  (select count(*)::integer from public.content_entries),
  'every entry has exactly three hashtags'
);

-- =============================================================================
-- anon reaches nothing
-- =============================================================================

set local role anon;

select throws_ok(
  $$ select public.hide_entry((select entry_id from fx)) $$,
  '42501'::varchar,
  null,
  'anon cannot hide an entry'
);

reset role;

select * from finish();
rollback;
