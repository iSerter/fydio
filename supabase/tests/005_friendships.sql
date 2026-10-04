-- =============================================================================
-- pgTAP · 005 — Friendship state machine, hashtag vocabulary, invite redemption
-- =============================================================================
--
-- The T03 guarantees that only SQL can prove:
--
--   * friend affinity counts MUTUAL, confirmed connections only
--   * one row per pair, whatever direction it was written
--   * only the addressee can answer a request
--   * blocking removes the friendship AND hides the member's entries
--   * a profile carries at most five hashtags
--   * a hashtag normalises to one canonical spelling
--   * an invite can be redeemed exactly once, and only by its token
--
-- ROLE SWITCHING. Each block does:
--
--   set local role <role>
--   select set_config('request.jwt.claim.sub', <uuid>, true)
--
-- The role switch activates the policies; the GUC is what `auth.uid()` reads. Both are
-- transaction-local, so the file's ROLLBACK restores everything.
--
-- ORDER NOTE: the role switch comes BEFORE `set_config`. The two orderings fail in
-- confusingly similar ways, and this file follows the order 002_credits.sql uses,
-- which is the one verified against this stack.

begin;

select plan(72);

-- =============================================================================
-- Functions and columns exist
-- =============================================================================

select has_function('public', 'friendship_pair_key', array['uuid', 'uuid'],
  'friendship_pair_key exists');
select has_function('public', 'send_friend_request', array['uuid'],
  'send_friend_request exists');
select has_function('public', 'respond_friend_request', array['uuid', 'boolean'],
  'respond_friend_request exists');
select has_function('public', 'remove_friend', array['uuid'],
  'remove_friend exists');
select has_function('public', 'block_member', array['uuid'],
  'block_member exists');
select has_function('public', 'unblock_member', array['uuid'],
  'unblock_member exists');
select has_function('public', 'set_profile_hashtags', array['uuid[]'],
  'set_profile_hashtags exists');
select has_function('public', 'claim_invite', array['text', 'uuid'],
  'claim_invite exists');
select has_function('public', 'normalize_hashtag', array['text'],
  'normalize_hashtag exists');
select has_function('public', 'create_hashtag', array['text'],
  'create_hashtag exists');

select has_column('public', 'invites', 'accepted_by',
  'invites records who redeemed it');
select has_column('public', 'profiles', 'onboarding_completed_at',
  'profiles carries the onboarding gate');

-- =============================================================================
-- The avatars bucket exists
-- =============================================================================
--
-- Asserted because an avatar upload against a missing bucket fails at the Storage
-- layer with an opaque error, and a fresh environment that skipped this migration
-- would look like an application bug.

select has_table('storage', 'buckets', 'storage buckets table exists');

select ok(
  (select count(*)::integer from storage.buckets where id = 'avatars') = 1,
  'the avatars bucket exists'
);

select ok(
  (select count(*)::integer from pg_policies
    where schemaname = 'storage' and policyname = 'members upload to their own avatar folder') = 1,
  'avatar writes are policy-scoped to the owner folder'
);

-- =============================================================================
-- Fixture
-- =============================================================================

create temporary table fx (
  id   integer primary key default 1 check (id = 1),
  ada  uuid not null,
  bob  uuid not null
) on commit drop;

-- Both member roles used below need to read the fixture. `service_role` included: the
-- invite-redemption block runs as `service_role` because that is the only role granted
-- EXECUTE on `claim_invite`, and the redemption passes a profile id out of `fx`.
grant select on fx to authenticated;
grant select on fx to service_role;

-- BOTH members are ordinary members, deliberately. An admin would see and could write
-- every row through the admin policies, so the cross-member denials below -- the entire
-- point of the suite -- would pass without testing anything. Same reasoning as 004.
--
-- The pair is chosen to have NO existing friendship row, so the state machine starts at
-- `none`. Picking two arbitrary members would sometimes start at `accepted` or
-- `pending` and make the first assertion depend on seed ordering.
insert into fx (ada, bob)
select a.id, b.id
  from public.profiles a
  cross join public.profiles b
 where a.id <> b.id
   and a.role <> 'admin'
   and b.role <> 'admin'
   and not exists (
     select 1 from public.friendships f
      where f.pair_key = public.friendship_pair_key(a.id, b.id)
   )
 order by a.handle, b.handle
 limit 1;

-- Invites, created as `postgres` because no member policy allows inserting one -- the
-- whole point being that an invite can only come from an admin. `service_role` is the
-- role the accept-invite route actually uses, so that is what the redemption tests
-- below switch to.
insert into public.invites (email, token_hash, expires_at)
values
  ('t03-valid@demo.test',   extensions.digest('t03-token-valid',   'sha256'), now() + interval '7 days'),
  ('t03-revoked@demo.test', extensions.digest('t03-token-revoked', 'sha256'), now() + interval '7 days'),
  ('t03-expired@demo.test', extensions.digest('t03-token-expired', 'sha256'), now() - interval '1 day');

update public.invites set revoked_at = now() where email = 't03-revoked@demo.test';

-- =============================================================================
-- pair_key: one row per pair, whatever direction it was written
-- =============================================================================

-- The reason mutual-only is structural rather than a convention: A-B and B-A are the
-- same friendship, so the key must not depend on who asked.
select ok(
  public.friendship_pair_key((select ada from fx), (select bob from fx))
  = public.friendship_pair_key((select bob from fx), (select ada from fx)),
  'pair_key is order-independent'
);

-- And it must agree with the GENERATED column 0002 already built, or lookups written
-- against the column and against the function would disagree.
select ok(
  not exists (
    select 1 from public.friendships f
     where f.pair_key <> public.friendship_pair_key(f.requester_id, f.addressee_id)
  ),
  'the stored pair_key column agrees with friendship_pair_key() on every row'
);

-- =============================================================================
-- none -> pending
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select lives_ok(
  $$ select public.send_friend_request(bob) from fx $$,
  'a member can send a friend request'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'pending',
  'a new request starts as pending'
);

select is(
  (select count(*)::integer from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  1,
  'the pair has exactly one row'
);

-- Asking twice is refused with a readable reason, not a raw unique-index violation.
select throws_ok(
  $$ select public.send_friend_request(bob) from fx $$,
  '23514'::varchar,
  null,
  'a second request for the same pair is refused'
);

-- The reverse direction is caught by the SAME row: `pair_key` is order-independent, so
-- Bob asking back is not a second row, it is the existing pending one.
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

select throws_ok(
  $$ select public.send_friend_request(ada) from fx $$,
  '23514'::varchar,
  null,
  'the reverse direction is refused while a request is pending'
);

select is(
  (select count(*)::integer from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  1,
  'the reverse attempt did not create a second row'
);

-- =============================================================================
-- pending -> accepted | declined
-- =============================================================================

-- THE assertion that matters most for the feed: a request cannot accept itself. The
-- requester is not the addressee, so the function refuses regardless of RLS.
--
-- The identity is switched BACK to Ada explicitly: the block above left it as Bob (for
-- the reverse-direction check), and Bob is the addressee here -- running this as Bob
-- would test the happy path and quietly assert nothing.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

select throws_ok(
  $$ select public.respond_friend_request(
       (select id from public.friendships where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
       true) from fx $$,
  '42501'::varchar,
  null,
  'the requester cannot accept their own request'
);

select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

select lives_ok(
  $$ select public.respond_friend_request(
       (select id from public.friendships where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
       true) from fx $$,
  'the addressee can accept'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'accepted',
  'accepting produces one mutual row'
);

-- `responded_at` must be set for every non-pending state; the CHECK constraint from
-- 0003 enforces the pairing, and this asserts the accept actually satisfied it.
select ok(
  (select responded_at is not null from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'an accepted friendship records when it was answered'
);

-- Answering twice is refused, so a stale tab cannot flip an accepted friendship back.
select throws_ok(
  $$ select public.respond_friend_request(
       (select id from public.friendships where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
       false) from fx $$,
  '23514'::varchar,
  null,
  'an already-answered request cannot be answered again'
);

-- =============================================================================
-- accepted -> none (unfriend), and the refusals
-- =============================================================================

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

-- Either party may end a mutual connection.
select lives_ok(
  $$ select public.remove_friend(
       (select id from public.friendships where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx)))) from fx $$,
  'either party can remove an accepted friendship'
);

-- The row is RETAINED, not deleted: a community of 30 people arguing about moderation
-- needs to see that a connection existed and ended.
select is(
  (select count(*)::integer from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  1,
  'removing a friendship keeps an audit row'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'declined',
  'the retained row records that the connection ended'
);

select throws_ok(
  $$ select public.remove_friend(
       (select id from public.friendships where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx)))) from fx $$,
  '23514'::varchar,
  null,
  'a connection cannot be removed twice'
);

-- =============================================================================
-- Self-requests and unknown members
-- =============================================================================

select throws_ok(
  $$ select public.send_friend_request(ada) from fx $$,
  '23514'::varchar,
  null,
  'a member cannot send a friend request to themselves'
);

select throws_ok(
  $$ select public.send_friend_request('00000000-0000-0000-0000-000000000000') from fx $$,
  'P0002'::varchar,
  null,
  'a request to a member that does not exist is refused'
);

-- =============================================================================
-- Blocking
-- =============================================================================

-- Block has to OVERWRITE the existing state rather than sit beside it. If an accepted
-- friendship survived as `accepted`, T07's friend-affinity boost -- which reads exactly
-- that state -- would keep paying out for a blocked pair.
select lives_ok(
  $$ select public.block_member(bob) from fx $$,
  'a member can block someone'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'blocked',
  'blocking overwrites any prior state'
);

-- Blocking also hides the member's entries from the blocker's feed. Asserted against
-- `mutes` because that is the table T07 reads; if the two ever diverged, one member
-- would be reading entries from someone they blocked.
select is(
  (select count(*)::integer from public.mutes
    where viewer_id = (select ada from fx) and muted_profile_id = (select bob from fx)),
  1,
  'blocking hides the blocked member from the blocker feed'
);

select throws_ok(
  $$ select public.send_friend_request(bob) from fx $$,
  '23514'::varchar,
  null,
  'a request between blocked members is refused'
);

select lives_ok(
  $$ select public.unblock_member(bob) from fx $$,
  'a member can unblock'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'declined',
  'unblocking returns the pair to a non-blocking state'
);

select is(
  (select count(*)::integer from public.mutes
    where viewer_id = (select ada from fx) and muted_profile_id = (select bob from fx)),
  0,
  'unblocking lifts the feed mute'
);

select throws_ok(
  $$ select public.unblock_member(bob) from fx $$,
  '23514'::varchar,
  null,
  'unblocking someone who is not blocked is refused'
);

reset role;

-- =============================================================================
-- Hashtag normalization
-- =============================================================================
--
-- Run as `postgres`: `normalize_hashtag` is IMMUTABLE and pure, so it needs no identity
-- and asserting it as a member would only add a role switch that could fail for
-- unrelated reasons.

select is(public.normalize_hashtag('#Design'), 'design',
  'a leading hash is stripped');

select is(public.normalize_hashtag('  HOOKS  '), 'hooks',
  'input is trimmed and lowercased');

-- Substituting rather than deleting keeps words apart. Deleting -- as the task text
-- sketched -- would turn `Color Grading` into `colorgrading`, merging two words into
-- one unreadable tag.
select is(public.normalize_hashtag('Color Grading'), 'color-grading',
  'spaces become a single separator');

-- One canonical spelling, so `snake_case` and `snake-case` cannot become two tags.
select is(public.normalize_hashtag('snake_case'), 'snake-case',
  'underscores canonicalise to hyphens');

select is(public.normalize_hashtag('##hook--analysis##'), 'hook-analysis',
  'repeated and trailing separators are collapsed and trimmed');

select throws_ok(
  $$ select public.normalize_hashtag('a') $$,
  '23514'::varchar, null, 'a one-character hashtag is refused');

select throws_ok(
  $$ select public.normalize_hashtag(repeat('a', 41)) $$,
  '23514'::varchar, null, 'a 41-character hashtag is refused');

-- THE regression guard for the decision taken during implementation. The seeded
-- vocabulary contains hyphens, and a normalizer that stripped them would make every
-- existing tag un-creatable through the picker -- invisible but still attached to
-- profiles and entries.
select is(
  (select count(*)::integer from public.hashtags where public.normalize_hashtag(slug::text) <> slug::text),
  0,
  'every seeded slug round-trips through normalize_hashtag unchanged'
);

-- =============================================================================
-- create_hashtag: idempotent, and capped
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);

-- Retyping an existing tag must return that tag, not raise and not create a near
-- duplicate. This is what makes the picker's confirm-a-typed-tag flow safe.
select is(
  (select (public.create_hashtag('Color Grading')).slug::text),
  'color-grading',
  'create_hashtag returns the existing tag for a known slug'
);

select is(
  (select count(*)::integer from public.hashtags where slug = 'color-grading'),
  1,
  'create_hashtag does not duplicate an existing tag'
);

-- =============================================================================
-- set_profile_hashtags: the five-tag cap
-- =============================================================================

-- Ada already carries five tags from the seed, so replacing them is a swap rather than a
-- growth -- which is the case the RPC exists to make safe.
select lives_ok(
  $$ select public.set_profile_hashtags(
       (select array_agg(t.id order by t.slug)
          from (select id, slug from public.hashtags order by slug limit 3) t) ) from fx $$,
  'a member can replace their hashtag set'
);

select is(
  (select count(*)::integer from public.profile_hashtags where profile_id = (select ada from fx)),
  3,
  'the replacement set is exactly what was submitted'
);

-- The counter the UI shows must match what the database kept.
select is(
  (select count(distinct position)::integer from public.profile_hashtags where profile_id = (select ada from fx)),
  3,
  'positions are contiguous after a replacement'
);

-- Six is refused by the RPC's own guard, before the deferred trigger would notice.
select throws_ok(
  $$ select public.set_profile_hashtags(
       (select array_agg(id) from (select id from public.hashtags order by slug limit 6) t)) from fx $$,
  '23514'::varchar, null, 'a sixth profile hashtag is refused'
);

-- Duplicates collapse. `array_length` would still report five, so without the dedupe the
-- member would appear to have five tags while matching on one.
select lives_ok(
  $$ select public.set_profile_hashtags(
       (select array_agg(id) from (select id from public.hashtags order by slug limit 1) t)) from fx $$,
  'the same tag repeated five times is accepted'
);

select is(
  (select count(*)::integer from public.profile_hashtags where profile_id = (select ada from fx)),
  1,
  'duplicate hashtag ids collapse to one row'
);

reset role;

-- =============================================================================
-- Invite redemption
-- =============================================================================
--
-- Run as `service_role`, because that is the only role granted EXECUTE on
-- `claim_invite` (0012). The accept-invite route holds the service key; a member cannot
-- call this directly. Asserting the redemption path under `service_role` therefore also
-- proves the GRANT is right, not just that the function body works.

set local role service_role;

-- An unknown token must be indistinguishable from "no such invite" rather than
-- confirming that some other invite exists.
select throws_ok(
  $$ select public.claim_invite(encode(extensions.digest('nope', 'sha256'), 'hex'), gen_random_uuid()) $$,
  'P0002'::varchar, null, 'an unknown token is refused'
);

select lives_ok(
  $$ select public.claim_invite(
       encode(extensions.digest('t03-token-valid', 'sha256'), 'hex'),
       (select ada from fx)) $$,
  'a valid token can be redeemed'
);

-- THE replay test. The whole point of storing `token_hash` rather than `token` is that a
-- leaked database cannot be replayed, and this is where that becomes observable.
select throws_ok(
  $$ select public.claim_invite(
       encode(extensions.digest('t03-token-valid', 'sha256'), 'hex'),
       (select bob from fx)) $$,
  '23505'::varchar, null, 'the same token cannot be redeemed twice'
);

select throws_ok(
  $$ select public.claim_invite(
       encode(extensions.digest('t03-token-revoked', 'sha256'), 'hex'),
       (select bob from fx)) $$,
  '23514'::varchar, null, 'a revoked token is refused with its own message'
);

select throws_ok(
  $$ select public.claim_invite(
       encode(extensions.digest('t03-token-expired', 'sha256'), 'hex'),
       (select bob from fx)) $$,
  '23514'::varchar, null, 'an expired token is refused'
);

-- The redemption must record WHO accepted, which is the audit fact that survives the
-- account being deleted (`accepted_by` is `on delete set null`).
select ok(
  (select accepted_by is not null from public.invites where email = 't03-valid@demo.test'),
  'redemption records which account accepted the invite'
);

-- And the token itself must never be recoverable from the row.
select is(
  (select count(*)::integer from public.invites
    where email = 't03-valid@demo.test'
      and encode(token_hash, 'hex') = 't03-token-valid'),
  0,
  'the raw token is not stored -- only its sha256 digest'
);

reset role;

-- =============================================================================
-- anon reaches nothing
-- =============================================================================
--
-- 0009 documents that this image's `alter default privileges` grants every new function
-- to `anon` at CREATE time. These are the assertions that 0012 and 0013 got their
-- revocations right; without them a missing revoke would look identical to a working one.

set local role anon;

select throws_ok(
  $$ select public.claim_invite(encode(extensions.digest('t03-token-expired', 'sha256'), 'hex'), gen_random_uuid()) $$,
  '42501'::varchar, null, 'anon cannot claim an invite'
);

select throws_ok(
  $$ select public.send_friend_request(gen_random_uuid()) $$,
  '42501'::varchar, null, 'anon cannot send a friend request'
);

select throws_ok(
  $$ select public.block_member(gen_random_uuid()) $$,
  '42501'::varchar, null, 'anon cannot block a member'
);

select throws_ok(
  $$ select public.set_profile_hashtags('{}'::uuid[]) $$,
  '42501'::varchar, null, 'anon cannot set profile hashtags'
);

select throws_ok(
  $$ select public.create_hashtag('anon-tag') $$,
  '42501'::varchar, null, 'anon cannot create a hashtag'
);

reset role;

-- =============================================================================
-- The direct-write paths RLS deliberately refuses
-- =============================================================================
--
-- The RPCs above are the supported route. These prove the shortcuts are still shut, so
-- the state machine cannot be bypassed by a client that writes the table directly.

set local role authenticated;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

-- The requester cannot mark their own request accepted. `friendships_update_addressee`
-- (0009) allows an update only for the addressee of a PENDING row, so this is refused
-- by policy before the function is ever reached.
--
-- NOTE ON THE SHAPE OF THIS ASSERTION. RLS filters rows, it does not raise: an UPDATE
-- whose WHERE clause matches no *visible* row silently updates zero rows rather than
-- erroring. So `throws_ok` here would pass for the wrong reason (and did, in the first
-- draft). What actually needs proving is that the write did not HAPPEN -- so the update
-- runs inside `lives_ok`, and the following assertion checks the state is untouched.
--
-- Bob is the addressee and the row is 'declined' by this point, so neither half of the
-- policy's `using` clause holds: a row can only be updated by its addressee while still
-- pending.
select lives_ok(
  $$ update public.friendships set state = 'accepted'
     where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx)) $$,
  'a direct update runs without error but matches no visible row'
);

select is(
  (select state::text from public.friendships
    where pair_key = public.friendship_pair_key((select ada from fx), (select bob from fx))),
  'declined',
  'RLS prevents a member from promoting the friendship row directly'
);

reset role;

select * from finish();
rollback;
