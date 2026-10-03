-- =============================================================================
-- pgTAP · 001 — Structural invariants
-- =============================================================================
--
-- The rules from the brief that are about the SHAPE of data rather than about
-- money or reputation: hashtag counts, feedback bounds, friendship sanity.
--
-- Every file is wrapped in `begin … rollback` so a test can never leave state
-- behind for the next one, and so a failing test rolls back rather than poisoning
-- the rest of the suite.
--
-- The deferred constraint triggers (five profile hashtags, exactly three entry
-- hashtags) fire at COMMIT — so these tests deliberately do NOT test them by
-- committing. A deferred trigger cannot be exercised inside a transaction that
-- rolls back, and testing it that way would produce a false pass. They are covered
-- in 002_credits.sql inside a savepoint-free subtransaction, and proven end to end
-- by `pnpm db:reset` running the seed, which commits.

begin;

select plan(25);

-- --- Tables exist -------------------------------------------------------------

select has_table('public', 'content_entries', 'content entries exist');
select has_table('public', 'credit_ledger', 'credit ledger exists');
select has_table('public', 'reputation_ledger', 'reputation ledger exists');
select has_table('public', 'feedback', 'feedback exists');

-- --- Enums are separate types --------------------------------------------------
--
-- The brief forbids conflating Credits and Reputation. Separate enum types make it
-- structural; a test asserting that is the cheapest possible guard against someone
-- later "simplifying" them into one.

select has_type('public', 'credit_kind', 'credit_kind exists');
select has_type('public', 'reputation_kind', 'reputation_kind exists');

select isnt(
  (select typname from pg_type where typname = 'credit_kind'),
  (select typname from pg_type where typname = 'reputation_kind'),
  'credit_kind and reputation_kind are distinct types'
);

-- Reputation has no spendable state at all.
-- No enum value is shared between the two ledgers, so there is no single `kind`
-- column that could ever accept both. Asserted by counting the overlap directly
-- rather than with a pgTAP helper: there is no `hasnt_type` for enums.
select is(
  (
    select count(*)::integer
      from unnest(enum_range(null::public.credit_kind))
      c
      join unnest(enum_range(null::public.reputation_kind)) r
        on r::text = c::text
  ),
  0,
  'no value is shared between credit_kind and reputation_kind'
);

-- Reputation has no spendable state at all: no 'spent', no 'available', no 'held'.
select is(
  (
    select count(*)::integer
      from unnest(enum_range(null::public.reputation_kind)) r
      where r::text in ('spent', 'available', 'held')
  ),
  0,
  'reputation_kind contains no spendable state'
);

-- --- Rating bounds ---------------------------------------------------------------

select throws_ok(
  $$ insert into public.feedback_ratings (feedback_id, entry_owner_id, rater_id, score)
     values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 11) $$,
  '23514'::varchar,
  null,
  'a rating above 10 is refused'
);

select throws_ok(
  $$ insert into public.feedback_ratings (feedback_id, entry_owner_id, rater_id, score)
     values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 0) $$,
  '23514'::varchar,
  null,
  'a rating below 1 is refused'
);

-- --- Friendships --------------------------------------------------------------------

select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     select id, id from public.profiles limit 1 $$,
  '23514'::varchar,
  null,
  'a member cannot befriend themselves'
);

-- --- Hashtag slugs --------------------------------------------------------------------

select throws_ok(
  $$ insert into public.hashtags (slug, label) values ('Not A Slug!', 'x') $$,
  '23514'::varchar,
  null,
  'a hashtag must be a slug'
);

-- --- Handles ----------------------------------------------------------------------------

select throws_ok(
  $$ update public.profiles set handle = 'No Spaces Allowed' $$,
  '23514'::varchar,
  null,
  'a handle cannot contain spaces'
);

-- --- Feedback body bounds -------------------------------------------------------------------
--
-- Ten characters is the storage floor. The *eligibility* threshold (40 by default) is
-- applied by submit_feedback, not by this constraint — a short note is stored and
-- simply earns nothing.

select throws_ok(
  $$ insert into public.feedback (entry_id, author_id, body)
     select id, id, 'short' from public.content_entries limit 1 $$,
  '23514'::varchar,
  null,
  'feedback shorter than the floor is refused'
);

select throws_ok(
  $$ insert into public.feedback (entry_id, author_id, body)
     select id, id, repeat('x', 4001) from public.content_entries limit 1 $$,
  '23514'::varchar,
  null,
  'feedback longer than the ceiling is refused'
);

-- --- Feedback image cap ------------------------------------------------------------------------
--
-- Three images maximum (brief §7, MAX_FEEDBACK_IMAGES in @fydio/domain).

select throws_ok(
  $$ insert into public.feedback (entry_id, author_id, body, image_paths)
     select id, id, repeat('y', 50), array['a.png','b.png','c.png','d.png']
     from public.content_entries limit 1 $$,
  '23514'::varchar,
  null,
  'a fourth feedback image is refused'
);

-- --- Reputation cannot be edited directly -----------------------------------------------------
--
-- Append-only. If this ever passes, a member could rewrite their own reputation by
-- updating a row, and the totals would stop being a function of the ratings.

select lives_ok(
  $$ insert into public.reputation_ledger (user_id, delta, kind)
     select id, 5, 'creator_rating' from public.profiles limit 1 $$,
  'a reputation row can be inserted'
);

select throws_ok(
  $$ update public.reputation_ledger set delta = 999 $$,
  '42501'::varchar,
  null,
  'a reputation row cannot be updated'
);

select throws_ok(
  $$ delete from public.reputation_ledger $$,
  '42501'::varchar,
  null,
  'a reputation row cannot be deleted'
);

-- --- Credit ledger immutability ------------------------------------------------------------------
--
-- Only `status` may move on a credit row. An editable `delta` would make
-- "credits spent on submissions" a number nobody could rely on.

select throws_ok(
  $$ update public.credit_ledger set delta = 1000 $$,
  '42501'::varchar,
  null,
  'a credit delta cannot be edited'
);

select throws_ok(
  $$ update public.credit_ledger set kind = 'admin_grant' $$,
  '42501'::varchar,
  null,
  'a credit kind cannot be edited'
);

-- --- Illegal status transitions ---------------------------------------------------------------------
--
-- `held -> available` and `held|available -> reversed` are legal. Retreating a
-- reversed credit would resurrect a revoked one.

-- Creates the row it then tries to resurrect. Without this the statement matches
-- nothing, raises nothing, and the test passes for the wrong reason — a green tick
-- that proves nothing about the transition guard.
insert into public.credit_ledger (user_id, delta, kind, status)
select id, 1, 'admin_grant', 'available' from public.profiles limit 1;

update public.credit_ledger set status = 'reversed'
 where kind = 'admin_grant' and status = 'available';

select throws_ok(
  $$ update public.credit_ledger set status = 'available' where status = 'reversed' $$,
  '23514'::varchar,
  null,
  'a reversed credit cannot become available again'
);

-- --- Moderation actions are append-only ----------------------------------------------------------------

-- Seeded as postgres, so a matching row exists to be edited.
insert into public.moderation_actions (actor_id, action, target_type, target_id)
select id, 'test_action', 'user', id::text from public.profiles limit 1;

select throws_ok(
  $$ update public.moderation_actions set action = 'x' $$,
  '42501'::varchar,
  null,
  'moderation actions cannot be edited'
);

select throws_ok(
  $$ delete from public.moderation_actions $$,
  '42501'::varchar,
  null,
  'moderation actions cannot be deleted'
);

select * from finish();
rollback;
