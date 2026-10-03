-- =============================================================================
-- pgTAP · 003 — Reputation
-- =============================================================================
--
-- Reputation is the quality signal: it rises when a creator rates someone's
-- feedback, and it can never be spent. This suite proves both halves.
--
-- The headline test is at the very bottom — the negative one. "500 reputation,
-- zero credits, still cannot submit" is the single most important assertion in the
-- whole task: it is the only test that would catch somebody quietly wiring
-- reputation into the submission path, which is precisely the conflation the brief
-- forbids.

begin;

select plan(17);

create temporary table fx (
  id   integer primary key default 1 check (id = 1),
  ada  uuid not null,
  bob  uuid not null,
  tags uuid[] not null
) on commit drop;

insert into fx (ada, bob, tags)
select
  (select id from public.profiles where role = 'admin'),
  (select id from public.profiles where role <> 'admin' order by handle limit 1),
  (select array_agg(id) from (select id from public.hashtags order by slug limit 3) t);

-- A fresh entry owned by Ada, so the rating rules can be exercised without depending
-- on whatever the seed happened to create.
insert into public.content_entries (
  author_id, platform, original_url, canonical_url, url_hash, status
)
select ada, 'youtube', 'https://rep.test/1', 'https://rep.test/1',
       extensions.digest('https://rep.test/1', 'sha256'), 'active'
from fx;

-- Created as the table owner, before any role switch. Under `authenticated` the RLS
-- policy on content_entries would allow this insert only for one's own entries, and
-- the feedback tests below need an entry Ada owns while running as Bob.
insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select e.id, h.id, h.rn
  from public.content_entries e
  cross join (select id, row_number() over (order by slug) - 1 as rn from public.hashtags) h
 where e.original_url = 'https://rep.test/1'
   and h.rn < 3;

set constraints all immediate;

select is(
  (select count(*)::integer
     from public.content_hashtags ch
     join public.content_entries e on e.id = ch.content_entry_id
    where e.original_url = 'https://rep.test/1'),
  3,
  'a reputation fixture entry is created with three tags'
);

-- Bob carries seeded reputation and seeded feedback of his own. The aggregate
-- assertions below are therefore written as DELTAS against a baseline captured here,
-- not as absolute numbers.
--
-- A baseline rather than a cleanup DELETE on purpose: `reputation_ledger` forbids
-- DELETE outright (that append-only guarantee is asserted in 001_invariants), and
-- disabling a trigger to make fixture setup convenient would weaken the very
-- property the suite exists to check. The credit ledger rows are cleared because
-- `credit_ledger` permits DELETE, and an absolute balance assertion needs a zero
-- starting point.
create temporary table fx_before as
select
  (select reputation_total    from public.profiles where id = (select bob from fx)) as rep_before,
  (select rated_feedback_count from public.profiles where id = (select bob from fx)) as cnt_before;

delete from public.credit_ledger
 where user_id = (select bob from fx)
    or user_id = (select ada from fx);

-- The baseline table is read from inside assertions that run as a member, so it
-- needs the same grant `fx` has.
grant select on fx, fx_before to authenticated;

-- The JWT claim is set BEFORE the first role switch on every occasion, because the
-- subquery that supplies its value reads `fx` -- and under `authenticated` that read
-- would itself need the grant. Setting it first keeps the two concerns separate:
-- resolve the identity as the owner, then act as that member.
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

-- --- Self-feedback -----------------------------------------------------------------
--
-- Bob gives Ada feedback, so Ada (the entry owner) can rate it. Bob cannot leave
-- feedback on his own entry, and the trigger refuses that independently of the RPC.

set local role authenticated;

select throws_ok(
  $$ select public.submit_feedback(
       (select id from public.content_entries where original_url = 'https://rep.test/1'),
       'Feedback long enough to satisfy the storage floor.') $$,
  '23514'::varchar,
  null,
  'feedback on your own content is refused'
);

-- And the trigger refuses it too, independently of the RPC. Asserted as the table
-- owner so RLS is out of the picture and only the trigger can be the reason.
reset role;

select throws_ok(
  $$ insert into public.feedback (entry_id, author_id, body, opened_entry)
     select (select id from public.content_entries where original_url = 'https://rep.test/1'),
            (select ada from fx),
            'Feedback long enough to satisfy the storage floor.', true $$,
  '23514'::varchar,
  null,
  'the trigger also refuses self-feedback from the entry owner'
);

reset role;

-- Bob writes a real feedback item for Ada to rate.
reset role;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ insert into public.feedback (entry_id, author_id, body, opened_entry)
     select (select id from public.content_entries where original_url = 'https://rep.test/1'),
            (select bob from fx),
            'Feedback long enough to satisfy the storage floor.', true $$,
  'feedback on someone else content is accepted'
);

select lives_ok(
  $$ select public.mark_entry_opened(
       (select id from public.content_entries where original_url = 'https://rep.test/1')) $$,
  'an open can be recorded'
);

-- =============================================================================
-- Rating
-- =============================================================================

reset role;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

-- Direct writes to the aggregates are refused for a member. Asserted as a member on
-- purpose: as the table owner the guard's `session_user`/`current_user` escape hatch
-- (0002) would legitimately permit it, since that is the SECURITY DEFINER refresh
-- path and not an attack.
select throws_ok(
  $$ update public.profiles set reputation_total = 500 where id = (select bob from fx) $$,
  '42501'::varchar,
  null,
  'reputation cannot be written directly'
);

select lives_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://rep.test/1'
         limit 1), 8::smallint) $$,
  'the entry owner can rate feedback'
);

-- Only once.
select throws_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://rep.test/1'
         limit 1), 9::smallint) $$,
  '23505'::varchar,
  null,
  'a feedback item cannot be rated twice'
);

-- Out of range.
select throws_ok(
  $$ select public.rate_feedback(
       (select id from public.feedback
         where entry_id = (select id from public.content_entries where original_url = 'https://rep.test/1')
          and author_id <> (select bob from fx) limit 1), 11::smallint) $$,
  '23514'::varchar,
  null,
  'a rating above 10 is refused by the RPC'
);

-- A non-owner cannot rate.
reset role;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://rep.test/1'
         limit 1), 3::smallint) $$,
  '42501'::varchar,
  null,
  'someone who does not own the entry cannot rate'
);

-- =============================================================================
-- THE AGGREGATES
-- =============================================================================

-- Deltas against the baseline: rating ONE item of feedback must move the total by
-- exactly the score and the count by exactly one, whatever the seed left behind.
select is(
  (select reputation_total from public.profiles where id = (select bob from fx))
    - (select rep_before from fx_before),
  8,
  'rating 8 raises the reputation total by exactly 8'
);

select is(
  (select rated_feedback_count from public.profiles where id = (select bob from fx))
    - (select cnt_before from fx_before),
  1,
  'the rated feedback count rises by exactly one'
);

-- =============================================================================
-- REPUTATION CANNOT BE SPENT — the headline test
-- =============================================================================
--
-- The test the task calls "the single most important test in the task". Bob is given
-- a large reputation by writing the ledger directly (as the owner, which is how a
-- moderation reversal would accumulate), while holding ZERO credits. If any part of
-- the submission path consulted reputation, this would succeed. It must not.

reset role;

-- Re-baseline here: the rating above already moved the total, so comparing against
-- the ORIGINAL snapshot would attribute that +8 to the reversal.
create temporary table fx_before2 as
select (select reputation_total from public.profiles where id = (select bob from fx)) as rep_before;

insert into public.reputation_ledger (user_id, delta, kind)
select bob, 500, 'moderation_reversal' from fx;

select public.refresh_profile_reputation(bob) from fx;

select is(
  (select reputation_total from public.profiles where id = (select bob from fx))
    - (select rep_before from fx_before2),
  500,
  'a 500-point moderation reversal moves the total by 500'
);

select is(
  (select public.get_credit_balance(bob) from fx),
  0,
  'and the credit balance is 0'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);

select throws_ok(
  $$ select public.create_content_entry(
       'youtube', 'https://rep.test/spend', 'https://rep.test/spend',
       (select tags from fx)) $$,
  '23514'::varchar,
  null,
  '500 reputation and 0 credits still cannot submit'
);

select is(
  (select public.get_credit_balance((select bob from fx)) ),
  0,
  'the refused submission cost nothing'
);

reset role;

-- The structural guarantee, asserted directly: no credit-awarding function mentions
-- the reputation ledger. A grep-style test, because a comment is not enforcement.
select is(
  (
    select count(*)::integer
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       -- The credit-awarding paths.
       and p.proname in (
         'create_content_entry',
         'evaluate_feedback_eligibility',
         'submit_feedback',
         'grant_weekly_allowance',
         'admin_grant_credit'
       )
       and pg_get_functiondef(p.oid) like '%reputation_ledger%'
  ),
  0,
  'no credit-awarding function references reputation_ledger'
);

select * from finish();
rollback;
