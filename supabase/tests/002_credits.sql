-- =============================================================================
-- pgTAP · 002 — Credit ledger
-- =============================================================================
--
-- Credits are the only spendable currency in Fydio, so this suite is mostly about
-- one question: does the balance move by exactly the right amount, exactly once?
--
-- It also covers the two DEFERRED constraint triggers — five profile hashtags and
-- exactly three entry hashtags. Those fire at COMMIT, which is a genuine problem
-- inside pgTAP: the whole file runs in a transaction that is rolled back, so a
-- deferred trigger would never fire and a test of it would pass vacuously.
--
-- The technique used below is `set constraints ... immediate`, which forces
-- Postgres to check every pending deferred trigger right there. That is what makes
-- these tests real rather than decorative.

begin;

select plan(21);

-- Isolated fixtures. Fixed uuids so a failure is reproducible by eye, and a
-- dedicated pair so this suite never fights the seeded rows for balances.
-- A single-row fixture: one row, so no composite primary key is needed and every
-- lookup below can be a bare `from fx`.
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

select is(
  (select count(*)::integer from fx), 1,
  'fixtures built from the seeded data'
);

-- The seed already gave these members Credits and spends, so an absolute-balance
-- assertion would depend on seed data this suite does not control. Clearing the
-- fixture member's ledger rows first makes every number below an absolute value
-- derived only from what the test itself wrote -- which is the only way these
-- assertions can be trusted if the seed ever changes.
delete from public.credit_ledger
 where user_id in (select ada from fx) or user_id in (select bob from fx);

-- Aged past `app.new_member_grace_days` (14) on purpose. Inside the grace window the
-- rate cap in `create_content_entry` fires first and its error masks every credit
-- assertion below -- which is exactly what happened before this line existed: the
-- "cannot submit with no credits" test passed, but for the wrong reason.
update public.profiles
   set created_at = now() - interval '400 days'
 where id in (select ada from fx) or id in (select bob from fx);

-- Identity is established BEFORE any RPC runs. `get_credit_balance` is
-- SECURITY DEFINER but still refuses an anonymous caller, because it is answering
-- "is this person allowed to see this balance" — and with no `auth.uid()` there is
-- no answer. Running as `postgres` alone is not sufficient: `session_user` is the
-- owner, but `auth.uid()` reads the JWT claim, which has to be set explicitly.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
select set_config('request.jwt.claim.email', 'ada@demo.test', true);

-- Give Ada exactly 3 Credits so the arithmetic below is easy to state.
insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, 3, 'admin_grant', 'available', 'test grant' from fx;

select is(
  (select public.get_credit_balance(ada) from fx), 3,
  'a grant of 3 produces a balance of 3'
);

-- =============================================================================
-- The balance formula
-- =============================================================================
--
--   balance = sum(delta) WHERE status IN ('available', 'spent')
--
-- The critical property: a SPEND must reduce the balance. If spends were recorded
-- with a status the sum ignored, submissions would be free forever and every other
-- test here would still pass. This one assertion is what pins it down.

insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, -1, 'submission_spend', 'spent', 'test spend' from fx;

select is(
  (select public.get_credit_balance(ada) from fx), 2,
  'a spend of 1 reduces the balance to 2'
);

-- Held credits are NOT spendable. This is the review window from brief §9: a
-- freshly earned credit must not be usable until the window closes, or an abusive
-- feedback item could be spent before anyone had the chance to reverse it.

insert into public.credit_ledger (user_id, delta, kind, status, available_at, note)
select ada, 5, 'feedback_earned', 'held', now() + interval '48 hours', 'held credit' from fx;

select is(
  (select public.get_credit_balance(ada) from fx), 2,
  'a held credit does not count toward the balance'
);

-- Releasing it is what makes it count.
update public.credit_ledger
   set status = 'available'
 where kind = 'feedback_earned' and status = 'held' and user_id = (select ada from fx);

select is(
  (select public.get_credit_balance(ada) from fx), 7,
  'releasing the held credit raises the balance to 7'
);

-- =============================================================================
-- Reversals subtract exactly once
-- =============================================================================
--
-- The accounting rule: flipping the original to `reversed` removes its contribution,
-- and the paired audit row is ALSO `reversed` so it contributes nothing. If the
-- pairing were done the other way — inserting a negative sibling and leaving the
-- original alone — the balance would fall by twice the amount.

insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, 4, 'admin_grant', 'available', 'to be reversed' from fx;

select is(
  (select public.get_credit_balance(ada) from fx), 11,
  'balance is 11 before the reversal'
);

do $$
declare
  v_ada uuid;
  v_row public.credit_ledger;
  v_balance integer;
begin
  select ada into v_ada from fx;
  select * into v_row from public.credit_ledger
   where user_id = v_ada and kind = 'admin_grant' and delta = 4 limit 1;

  -- Exactly the shape admin_reverse_credit uses.
  update public.credit_ledger set status = 'reversed' where id = v_row.id;
  insert into public.credit_ledger (user_id, delta, kind, status, reverses_id, note)
  values (v_ada, -4, 'admin_reverse', 'reversed', v_row.id, 'reversal');

  v_balance := public.get_credit_balance(v_ada);
  if v_balance <> 7 then
    raise exception 'reversal subtracted the wrong amount: expected 7, got %', v_balance;
  end if;
end
$$;

select pass('a reversal subtracts the amount exactly once');

-- =============================================================================
-- Weekly allowance idempotency
-- =============================================================================
--
-- `grant_weekly_allowance` must be safe to retry: the sweeper will re-run, and a
-- double grant is a silent inflation of the money supply.

select is(
  public.grant_weekly_allowance(7),
  0,
  'a second allowance run in the same period grants nothing'
);

select is(
  (select count(*)::integer
     from public.credit_ledger
    where kind = 'weekly_allowance'
      and note like 'Weekly starter allowance for%'
      and created_at > now() - interval '1 hour'),
  0,
  'the retry wrote no allowance rows'
);

-- =============================================================================
-- create_content_entry: the atomic spend
-- =============================================================================

-- The fixture table lives in `pg_temp`, which `authenticated` cannot read by
-- default -- a temporary table inherits the creating role's grants and nothing
-- else. Without this the RPC calls below fail with "permission denied for table fx"
-- before ever reaching the credit logic.
grant select on fx to authenticated;

-- The role switch comes AFTER `set_config`: `set role` resets the session's GUC
-- state, so a claim set before the switch would be cleared and `auth.uid()` would
-- be NULL again.

-- Bob's ledger was cleared above, so his balance is genuinely zero. The check is for
-- a check_violation (the Insufficient Credits guard), not an auth failure.
select is(
  (select public.get_credit_balance(bob) from fx), 0,
  'bob starts with a zero balance'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
select set_config('request.jwt.claim.email', 'bob@demo.test', true);

select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/none', 'https://x.test/none', tags) from fx $$,
  '23514'::varchar,
  null,
  'a member with no credits cannot submit'
);

-- Back to Ada for the positive path.
reset role;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

-- Ada has plenty now (7 from above), so a normal submission must succeed and must
-- cost exactly one credit.
select lives_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/ok', 'https://x.test/ok', tags) from fx $$,
  'a member with credits can submit'
);

select is(
  (select public.get_credit_balance(ada) from fx), 6,
  'the submission cost exactly one credit'
);

-- The hashtag rules, checked through the RPC as well as the trigger.
select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/a', 'https://x.test/a', '{}'::uuid[]) from fx $$,
  '23514'::varchar,
  null,
  'an entry with no hashtags is refused'
);

select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/b', 'https://x.test/b',
       (select array_agg(id) from public.hashtags)) from fx $$,
  '23514'::varchar,
  null,
  'an entry with more than three hashtags is refused'
);

-- Duplicate hashtags collapse to fewer distinct tags, which must not slip through
-- the count: `array_length` would still say 3.
select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/c', 'https://x.test/c',
       array[(select id from public.hashtags order by slug limit 1),
             (select id from public.hashtags order by slug limit 1),
             (select id from public.hashtags order by slug limit 1)]) from fx $$,
  '23514'::varchar,
  null,
  'three copies of one hashtag are refused'
);

select throws_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/ok', 'https://x.test/ok', tags) from fx $$,
  '23505'::varchar,
  null,
  'the same URL cannot be submitted twice by one author'
);

reset role;

-- =============================================================================
-- THE DEFERRED TRIGGERS, forced to fire
-- =============================================================================
--
-- `set constraints all immediate` is what makes these two tests mean anything.
-- Without it the triggers would be pending until the file's ROLLBACK, never firing,
-- and both assertions would pass without testing anything.

select throws_ok(
  $$
  -- A FRESH profile rather than Ada's. Ada already carries five tags, so adding six
  -- more would trip the (profile_id, hashtag_id) primary key first and raise 23505 --
  -- the correct error for a duplicate tag, but one that says nothing about the
  -- six-hashtag limit. Starting from an empty profile isolates the rule under test.
  insert into auth.users (id, email, raw_user_meta_data)
  values ('ffffffff-0000-4000-8000-000000000001', 'taglimit@demo.test', '{}');

  insert into public.profile_hashtags (profile_id, hashtag_id, position)
  select p.id, h.id, h.rn
    from public.profiles p
    cross join (select id, row_number() over (order by slug) - 1 as rn
                  from public.hashtags) h
   where p.id = 'ffffffff-0000-4000-8000-000000000001'
     and h.rn < 6;

  set constraints all immediate;
  $$,
  '23514'::varchar,
  null,
  'a sixth profile hashtag is refused'
);

select throws_ok(
  $$
  -- ONE row, for an entry that does not already carry this tag.
  --
  -- Deterministic on both sides: the entry is a fixed `order by id limit 1`, and the
  -- tag is chosen from the pool AFTER excluding every tag already used by any entry.
  -- The earlier version picked "the first entry where the tag is missing", which
  -- depended on the seed's tag rotation and so passed or failed depending on it.
  --
  -- Excluding used tags matters: the (entry, hashtag) primary key is checked
  -- immediately and would fire before the deferred count trigger. Two different
  -- constraints raising two different codes is exactly what this distinguishes —
  -- 23505 says "duplicate tag", 23514 says "wrong number of tags".
  insert into public.content_hashtags (content_entry_id, hashtag_id, position)
  select
    (select id from public.content_entries order by id limit 1),
    (select h.id
       from public.hashtags h
      where not exists (select 1 from public.content_hashtags c where c.hashtag_id = h.id)
      order by h.slug
      limit 1),
    0;
  set constraints all immediate;
  $$,
  '23514'::varchar,
  null,
  'an entry with only one hashtag is refused'
);

-- Scoped to profiles that have FINISHED onboarding, deliberately.
--
-- A member part-way through the wizard is a normal row: they exist the moment their invitation
-- is redeemed and they choose five tags on step 4, so between those two points they legitimately
-- have zero. Asserting the invariant across every profile therefore fails the moment anybody
-- abandons onboarding halfway -- including the integration and E2E suites, which create members
-- precisely to abandon them at a chosen step.
--
-- `onboarding_completed_at` is the marker for "this member committed", and it is set by
-- `completeOnboarding` alone, so it distinguishes a half-finished member from a finished one
-- without counting tags as a proxy for the same thing.
--
-- The hard cap is still enforced for everyone: `set_profile_hashtags` and the deferred
-- constraint trigger refuse a sixth tag regardless of onboarding state, and both are asserted
-- by the tests above.
select is(
  (select count(*)::integer
     from (select ph.profile_id
             from public.profile_hashtags ph
             join public.profiles p on p.id = ph.profile_id
            where p.onboarding_completed_at is not null
            group by ph.profile_id
           having count(*) = 5) ok),
  (select count(*)::integer
     from public.profiles
    where onboarding_completed_at is not null),
  'every onboarded profile has exactly five hashtags'
);

select is(
  (select count(*)::integer
     from (select ch.content_entry_id
             from public.content_hashtags ch
            group by ch.content_entry_id
           having count(*) = 3) ok),
  (select count(*)::integer from public.content_entries),
  'every entry has exactly three hashtags'
);

select * from finish();
rollback;
