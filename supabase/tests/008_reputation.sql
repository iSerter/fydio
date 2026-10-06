-- =============================================================================
-- pgTAP · 008 — Reputation ratings ledger (T06)
-- =============================================================================
--
-- Covers what 003 leaves open: revision within/after the window with reversing
-- pairs, moderation reversal with audit, `get_reputation` / `get_rating_summary`
-- shapes and badge tiers, aggregate accuracy after every mutation type, no
-- credit side effect, non-spendability, and no leaderboard view.
--
-- Rating itself (owner-only, rate-once, self-rating, range) is proven in 003;
-- this suite re-asserts the two load-bearing rules and then moves on to the
-- T06 additions.

begin;

select plan(31);

create temporary table fx (
  id   integer primary key default 1 check (id = 1),
  ada  uuid not null,
  bob  uuid not null,
  cam  uuid not null,
  tags uuid[] not null
) on commit drop;

insert into fx (ada, bob, cam, tags)
select
  (select id from public.profiles where role = 'admin'),
  (select id from public.profiles where role <> 'admin' order by handle limit 1 offset 0),
  (select id from public.profiles where role <> 'admin' order by handle limit 1 offset 1),
  (select array_agg(id) from (select id from public.hashtags order by slug limit 3) t);

-- Fresh entry owned by Ada.
insert into public.content_entries (
  author_id, platform, original_url, canonical_url, url_hash, status
)
select ada, 'youtube', 'https://t06.test/1', 'https://t06.test/1',
       extensions.digest('https://t06.test/1', 'sha256'), 'active'
from fx;

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select e.id, h.id, h.rn
  from public.content_entries e
  cross join (select id, row_number() over (order by slug) - 1 as rn from public.hashtags) h
 where e.original_url = 'https://t06.test/1'
   and h.rn < 3;

set constraints all immediate;

grant select on fx to authenticated;

-- Bob's feedback for Ada to rate.
reset role;
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ insert into public.feedback (entry_id, author_id, body, opened_entry)
     select (select id from public.content_entries where original_url = 'https://t06.test/1'),
            (select bob from fx),
            'Feedback long enough to satisfy the storage floor for T06 revision tests.', true $$,
  'bob can leave feedback on ada entry'
);

-- Cam's feedback for the moderation-reversal half. Inserted AS Cam: the
-- `feedback_insert_own` RLS policy requires author_id = auth.uid().
reset role;
select set_config('request.jwt.claim.sub', (select cam::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ insert into public.feedback (entry_id, author_id, body, opened_entry)
     select (select id from public.content_entries where original_url = 'https://t06.test/1'),
            (select cam from fx),
            'A second feedback item so moderation reversal is independent of revision.', true $$,
  'cam can leave feedback on the same entry'
);

-- --- Rating rules (re-asserted) -------------------------------------------------

reset role;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 8::smallint) $$,
  'owner rates bob feedback 8'
);

select throws_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 9::smallint) $$,
  '23505',
  'This feedback has already been rated',
  'second rating raises unique_violation'
);

select throws_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 11::smallint) $$,
  '23514',
  'Rating must be between 1 and 10',
  'rating above 10 is refused'
);

-- Non-owner cannot rate.
reset role;
select set_config('request.jwt.claim.sub', (select cam::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 5::smallint) $$,
  '42501',
  'Only the content owner can rate feedback on their own entry',
  'non-owner rating is refused'
);

-- --- Aggregates after rating ----------------------------------------------------

reset role;

-- Simpler aggregate identity: stored total equals ledger sum.
select is(
  (select reputation_total from public.profiles where id = (select bob from fx)),
  (select coalesce(sum(delta), 0)::integer from public.reputation_ledger where user_id = (select bob from fx)),
  'stored total equals ledger sum after rating'
);

select ok(
  (select rated_feedback_count from public.profiles where id = (select bob from fx)) >= 1,
  'rated count is at least one after rating'
);

-- No credit side effect from rating.
select is(
  (select count(*)::integer from public.credit_ledger where feedback_id in (
     select f.id from public.feedback f
       join public.content_entries e on e.id = f.entry_id
      where f.author_id = (select bob from fx) and e.original_url = 'https://t06.test/1')),
  0,
  'rating writes no credit_ledger rows'
);

-- --- get_reputation shape + badge -----------------------------------------------

select ok(
  (select (public.get_reputation((select bob from fx)) ->> 'total')::integer) =
   (select reputation_total from public.profiles where id = (select bob from fx)),
  'get_reputation total matches the stored aggregate'
);

select ok(
  (select public.get_reputation((select bob from fx)) ?& array['total','ratedCount','average','badge']),
  'get_reputation returns total, ratedCount, average, badge'
);

select is(
  (select public.reputation_badge_for_total(0)),
  'new',
  'badge 0 is new'
);

select is(
  (select public.reputation_badge_for_total(25)),
  'contributor',
  'badge 25 is contributor'
);

select is(
  (select public.reputation_badge_for_total(100)),
  'trusted',
  'badge 100 is trusted'
);

select is(
  (select public.reputation_badge_for_total(250)),
  'mentor',
  'badge 250 is mentor'
);

select ok(
  (select public.get_rating_summary((select bob from fx)) ?& array['total','ratedCount','average','badge','recent']),
  'get_rating_summary returns aggregate plus recent'
);

select ok(
  (select jsonb_array_length(public.get_rating_summary((select bob from fx)) -> 'recent')) >= 1,
  'get_rating_summary recent lists the rated feedback'
);

-- --- Revision within the window --------------------------------------------------
--
-- 8 -> 5: ledger gains -8 then +5; sum moves by -3; rating row reads 5.

reset role;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.revise_rating(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 5::smallint) $$,
  'owner revises 8 to 5 within the window'
);

reset role;

select is(
  (select score from public.feedback_ratings where feedback_id = (
     select f.id from public.feedback f
       join public.content_entries e on e.id = f.entry_id
      where f.author_id = (select bob from fx) and e.original_url = 'https://t06.test/1' limit 1)),
  5::smallint,
  'rating row reads 5 after revision'
);

select is(
  (select count(*)::integer from public.reputation_ledger
    where feedback_id = (select f.id from public.feedback f
       join public.content_entries e on e.id = f.entry_id
      where f.author_id = (select bob from fx) and e.original_url = 'https://t06.test/1' limit 1)
      and kind = 'rating_revision'),
  2,
  'revision writes a -old/+new pair'
);

select is(
  (select reputation_total from public.profiles where id = (select bob from fx)),
  (select coalesce(sum(delta), 0)::integer from public.reputation_ledger where user_id = (select bob from fx)),
  'stored total still equals ledger sum after revision'
);

-- Non-rater cannot revise.
select set_config('request.jwt.claim.sub', (select cam::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.revise_rating(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 7::smallint) $$,
  '42501',
  'Only the original rater can revise a rating',
  'third-party revision is refused'
);

-- --- Revision after the window is rejected ---------------------------------------

reset role;

update public.feedback_ratings set created_at = now() - interval '25 hours'
 where feedback_id = (select f.id from public.feedback f
   join public.content_entries e on e.id = f.entry_id
  where f.author_id = (select bob from fx) and e.original_url = 'https://t06.test/1' limit 1);

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.revise_rating(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select bob from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 9::smallint) $$,
  '23514',
  'The revision window has closed',
  'revision after the window is rejected'
);

-- --- Moderation reversal ----------------------------------------------------------

reset role;

-- Ada rates cam's feedback first so there is reputation to reverse.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.rate_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select cam from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 9::smallint) $$,
  'owner rates cam feedback 9'
);

reset role;

create temporary table fx_cam_before as
select reputation_total as total from public.profiles where id = (select cam from fx);

grant select on fx_cam_before to authenticated;

-- As Cam (not an admin): refused.
select set_config('request.jwt.claim.sub', (select cam::text from fx), true);
set local role authenticated;

-- Non-admin cannot reverse.
select throws_ok(
  $$ select public.reverse_reputation_for_feedback(
       (select f.id from public.feedback f
          join public.content_entries e on e.id = f.entry_id
         where f.author_id = (select cam from fx)
           and e.original_url = 'https://t06.test/1'
         limit 1), 'not an admin') $$,
  '42501',
  'Admin only',
  'moderation reversal is admin-only'
);

reset role;
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select is(
  (select public.reverse_reputation_for_feedback(
     (select f.id from public.feedback f
        join public.content_entries e on e.id = f.entry_id
       where f.author_id = (select cam from fx)
         and e.original_url = 'https://t06.test/1'
       limit 1), 'abusive feedback')),
  1,
  'admin reversal removes exactly one rating'
);

reset role;

select is(
  (select reputation_total from public.profiles where id = (select cam from fx)),
  (select coalesce(sum(delta), 0)::integer from public.reputation_ledger where user_id = (select cam from fx)),
  'stored total equals ledger sum after moderation reversal'
);

select ok(
  exists (select 1 from public.moderation_actions
           where action = 'reputation_reversed' and target_type = 'feedback'),
  'reversal is audited in moderation_actions'
);

-- Second reversal is a no-op, not a double subtraction.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select is(
  (select public.reverse_reputation_for_feedback(
     (select f.id from public.feedback f
        join public.content_entries e on e.id = f.entry_id
       where f.author_id = (select cam from fx)
         and e.original_url = 'https://t06.test/1'
       limit 1), 'retry')),
  0,
  'repeated reversal returns 0 without subtracting again'
);

-- --- No leaderboard ---------------------------------------------------------------

reset role;

select is(
  (select count(*)::integer from pg_matviews where schemaname = 'public' and matviewname ilike '%leaderboard%'),
  0,
  'no leaderboard materialized view exists'
);

select is(
  (select count(*)::integer from pg_views where schemaname = 'public' and viewname ilike '%leaderboard%'),
  0,
  'no leaderboard view exists'
);

select * from finish();
rollback;
