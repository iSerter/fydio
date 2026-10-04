-- =============================================================================
-- pgTAP · 007 — Credit economy (T05)
-- =============================================================================
--
-- T02 proved the ledger arithmetic; this suite proves the economy built on top:
-- the private summary RPC, the weekly allowance, the hold window and its
-- sweeper, abuse reversals, and the admin ceiling.
--
-- Conventions follow 002/004: fixtures in temp tables, identity via
-- `set_config('request.jwt.claim.sub', …)` + `set local role`, everything
-- rolled back at the end.

begin;

select plan(42);

create temporary table fx (
  id    integer primary key default 1 check (id = 1),
  ada   uuid not null,
  bob   uuid not null,
  admin uuid not null,
  entry uuid not null
) on commit drop;

insert into fx (ada, bob, admin, entry)
select
  (select id from public.profiles where role <> 'admin' order by handle limit 1),
  (select id from public.profiles where role <> 'admin' order by handle offset 1 limit 1),
  (select id from public.profiles where role = 'admin' limit 1),
  (select e.id from public.content_entries e
    where e.author_id = (select id from public.profiles where role <> 'admin' order by handle offset 1 limit 1)
      and e.status = 'active'
    limit 1);

-- Carries ids minted mid-suite (entries, feedback, reports) between blocks.
-- Every feedback id is captured ENTRY-SCOPED at submit time: `now()` is the
-- transaction start, so every `created_at` in this file ties and any
-- "latest by author" lookup is nondeterministic. Never order by created_at
-- to find a row this suite wrote.
create temporary table fx2 (
  id          integer primary key default 1 check (id = 1),
  entry2      uuid,
  entry3      uuid,
  entry4      uuid,
  fb1         uuid,
  fb_reported uuid,
  fb_reversed uuid,
  fb_capped   uuid,
  fb_short    uuid,
  report      uuid
) on commit drop;

insert into fx2 (id) values (1);

select ok((select entry from fx) is not null, 'fixture entry exists');

grant select on fx to authenticated;
grant select on fx2 to authenticated;

-- Age fixtures past the new-member grace window so the submission rate cap
-- never masks a credit assertion (same trap 002 documents).
update public.profiles
   set created_at = now() - interval '400 days'
 where id in (select ada from fx) or id in (select bob from fx);

-- =============================================================================
-- Weekly allowance: idempotent, and reaches a brand-new member
-- =============================================================================
--
-- The seed (or an earlier run) already processed this week, so the current
-- run row is removed first — inside this transaction only — to observe a
-- genuine first run rather than asserting on a retry.

delete from public.weekly_allowance_runs
 where period_start = date_trunc('week', now() at time zone 'utc')::date;

-- A member who signed up after the last run: no auth row theatrics beyond what
-- 002 already proved works. (`handle_new_user()` provisions the profile row
-- automatically, so this is an update, not an insert — inserting would collide
-- on the trigger-created row.)
insert into auth.users (id, email, raw_user_meta_data)
values ('ffffffff-0000-4000-8000-000000000007', 't05new@demo.test', '{}');

update public.profiles
   set handle = 't05_new_member', display_name = 'T05 New',
       created_at = now() - interval '400 days'
 where id = 'ffffffff-0000-4000-8000-000000000007';

select ok(
  public.grant_weekly_allowance() > 0,
  'first allowance run of the week grants to members'
);

select is(
  (select count(*)::integer from public.credit_ledger
    where user_id = 'ffffffff-0000-4000-8000-000000000007'
      and kind = 'weekly_allowance' and status = 'available'),
  1,
  'a newly-signed-up member receives the starter allowance on the first run'
);

select is(
  public.grant_weekly_allowance(),
  0,
  'a second allowance run in the same week grants nothing'
);

-- The allowance gave every profile a row; clear the fixtures so every number
-- below is derived only from what this suite writes (002's discipline).
delete from public.credit_ledger
 where user_id in (select ada from fx) or user_id in (select bob from fx);

-- =============================================================================
-- get_credit_summary: shape, arithmetic, privacy
-- =============================================================================

insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, 3, 'admin_grant', 'available', 'summary test grant' from fx;

insert into public.credit_ledger (user_id, delta, kind, status, note)
select ada, -1, 'submission_spend', 'spent', 'summary test spend' from fx;

insert into public.credit_ledger (user_id, delta, kind, status, available_at, note)
select ada, 1, 'feedback_earned', 'held', now() + interval '48 hours', 'summary test held' from fx;

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select is(
  (select (public.get_credit_summary(ada))->>'available' from fx),
  '2',
  'summary available follows the 0004 formula (grants minus spends, held excluded)'
);

select is(
  (select (public.get_credit_summary(ada))->>'held' from fx),
  '1',
  'summary reports held separately'
);

select is(
  (select (public.get_credit_summary(ada))->>'submissionCost' from fx),
  (select public.app_setting_int('app.credit_submission_cost', 1)::text),
  'summary carries the submission cost'
);

select ok(
  (select jsonb_array_length((public.get_credit_summary(ada))->'history') from fx) <= 50,
  'summary history is capped at 50 rows'
);

select is(
  (select public.get_credit_balance(ada) from fx),
  ((select (public.get_credit_summary(ada))->>'available' from fx))::integer,
  'summary available agrees with get_credit_balance'
);

reset role;

-- Bob reads Ada's balance: refused.
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.get_credit_summary(ada) from fx $$,
  '42501',
  'Credit balance is private',
  'a member cannot read another member''s credit summary'
);

reset role;

-- An admin can (support tooling needs it; members cannot).
select set_config('request.jwt.claim.sub', (select admin::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.get_credit_summary(ada) from fx $$,
  'an admin can read a member''s credit summary'
);

reset role;

-- =============================================================================
-- Earn → hold → release, with the review window honoured
-- =============================================================================
--
-- `submit_feedback` is member-callable; `evaluate_feedback_eligibility` is a
-- job (service_role), so evaluation runs as postgres — the same split the
-- `/api/feedback` route implements with member + service clients.

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

-- The open mark `submit_feedback` requires (brief §2: connected to an entry
-- they opened).
select lives_ok(
  $$ select public.mark_entry_opened(entry) from fx $$,
  'ada opens bob''s entry'
);

select lives_ok(
  $$ select public.submit_feedback(entry,
         'The hook lands in the first two seconds and the payoff is clearly framed; I would tighten the middle third where the pacing sags.',
         '{hook,storytelling}') from fx $$,
  'ada submits qualifying feedback on bob''s entry'
);

reset role;

-- Evaluate as the job would (postgres bypasses the EXECUTE grants the way the
-- service_role client does). By explicit id: entry-scoped, never "latest".
update fx2 set fb1 = (select id from public.feedback
 where author_id = (select ada from fx) and entry_id = (select entry from fx));

select is(
  (select public.evaluate_feedback_eligibility(fb1) from fx2),
  'eligible'::eligibility_state,
  'qualifying feedback evaluates eligible'
);

-- Clear the hand-written held row from the summary block so the only held
-- credit is the one just earned (its review window is still open).
delete from public.credit_ledger
 where user_id = (select ada from fx) and note = 'summary test held';

select is(
  (select public.get_credit_balance(ada) from fx),
  2,
  'a held credit does not count toward the spendable balance'
);

-- Fast-forward past the review window and sweep. The count is a LOWER bound:
-- the seed holds other members' due rows and the sweeper correctly releases
-- those too — what matters here is that ADA's row is among them.
update public.credit_ledger
   set available_at = now() - interval '1 hour'
 where user_id = (select ada from fx) and status = 'held';

select ok(
  public.release_held_credits() >= 1,
  'the sweeper releases due held credits'
);

select is(
  (select status::text from public.credit_ledger
    where feedback_id = (select fb1 from fx2) and kind = 'feedback_earned'),
  'available',
  'ada''s held credit is released'
);

select is(
  (select public.get_credit_balance(ada) from fx),
  3,
  'releasing the held credit raises the balance'
);

-- =============================================================================
-- The sweeper skips contested feedback; resolving the report reverses it
-- =============================================================================
--
-- Reported AFTER earning but BEFORE release: the earn-time guard in
-- `evaluate_feedback_eligibility` cannot see the future, so the sweeper must.
-- Resolving the report then exercises the 0016 wiring
-- (`admin_resolve_report` → `reverse_credit_for_feedback`).

-- A second entry by bob, with its exactly-three tags (the deferred trigger
-- only fires at COMMIT, which this file never reaches — but the rows are
-- written anyway so the invariant holds even under `set constraints immediate`).
insert into public.content_entries
  (author_id, platform, original_url, canonical_url, url_hash, status, published_at)
select bob, 'youtube', 'https://x.test/t05-reported', 'https://x.test/t05-reported',
       extensions.digest('https://x.test/t05-reported', 'sha256'), 'active', now()
  from fx;

update fx2 set entry2 = (select id from public.content_entries where canonical_url = 'https://x.test/t05-reported');

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select (select entry2 from fx2), id, ord - 1
  from (select id, row_number() over (order by slug) as ord from public.hashtags limit 3) t;

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.mark_entry_opened(entry2) from fx2 $$,
  'ada opens the second entry'
);

select lives_ok(
  $$ select public.submit_feedback(entry2,
         'Strong thumbnail and a clear promise in the title; the middle could use one concrete example before the conclusion arrives.',
         '{thumbnail,clarity}') from fx2 $$,
  'ada submits feedback on the second entry'
);

reset role;

update fx2 set fb_reported = (select id from public.feedback
 where author_id = (select ada from fx) and entry_id = (select entry2 from fx2));

select is(
  (select public.evaluate_feedback_eligibility(fb_reported) from fx2),
  'eligible'::eligibility_state,
  'the second feedback evaluates eligible and its credit is held'
);

-- A report arrives while the credit is still held.
insert into public.moderation_reports (reporter_id, target_type, target_id, reason)
select bob, 'feedback', (select fb_reported::text from fx2), 'spammy feedback'
  from fx;

update fx2 set report = (select id from public.moderation_reports
 where target_type = 'feedback' and target_id = (select fb_reported::text from fx2)
 order by created_at desc limit 1);

update public.credit_ledger
   set available_at = now() - interval '1 hour'
 where user_id = (select ada from fx) and status = 'held';

select is(
  public.release_held_credits(),
  0,
  'the sweeper releases nothing while the feedback is reported'
);

select is(
  (select status::text from public.credit_ledger
    where feedback_id = (select fb_reported from fx2) and kind = 'feedback_earned'),
  'held',
  'the contested credit stays held'
);

-- Resolving the report as abuse reverses the credit through the 0016 path.
select set_config('request.jwt.claim.sub', (select admin::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.admin_resolve_report(report, 'resolved', 'confirmed spam') from fx2 $$,
  'an admin resolves the feedback report as abuse'
);

reset role;

select is(
  (select eligibility::text from public.feedback where id = (select fb_reported from fx2)),
  'reversed',
  'resolving as abuse marks the feedback reversed'
);

select is(
  (select count(*)::integer from public.credit_ledger
    where feedback_id = (select fb_reported from fx2)
      and kind = 'hold_reversal' and status = 'reversed'
      and reverses_id is not null and delta < 0),
  1,
  'the reversal writes one paired audit row under the 0004 rule'
);

select is(
  (select public.get_credit_balance(ada) from fx),
  3,
  'reversing a held credit leaves the spendable balance untouched, exactly once'
);

-- =============================================================================
-- Direct reversal of a held credit + idempotency + auth
-- =============================================================================

insert into public.content_entries
  (author_id, platform, original_url, canonical_url, url_hash, status, published_at)
select bob, 'youtube', 'https://x.test/t05-heldrev', 'https://x.test/t05-heldrev',
       extensions.digest('https://x.test/t05-heldrev', 'sha256'), 'active', now()
  from fx;

update fx2 set entry3 = (select id from public.content_entries where canonical_url = 'https://x.test/t05-heldrev');

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select (select entry3 from fx2), id, ord - 1
  from (select id, row_number() over (order by slug) as ord from public.hashtags limit 3) t;

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.mark_entry_opened(entry3) from fx2 $$,
  'ada opens the third entry'
);

select lives_ok(
  $$ select public.submit_feedback(entry3,
         'The editing rhythm carries the piece and the call to action is unmistakable; consider a colder open to earn the first cut.',
         '{editing,cta}') from fx2 $$,
  'ada submits feedback on the third entry'
);

reset role;

update fx2 set fb_reversed = (select id from public.feedback
 where author_id = (select ada from fx) and entry_id = (select entry3 from fx2));

select is(
  (select public.evaluate_feedback_eligibility(fb_reversed) from fx2),
  'eligible'::eligibility_state,
  'the third feedback evaluates eligible and its credit is held'
);

select set_config('request.jwt.claim.sub', (select admin::text from fx), true);
set local role authenticated;

select is(
  (select public.reverse_credit_for_feedback(fb_reversed, 'test reversal') from fx2),
  1,
  'reversing a held credit returns 1'
);

select is(
  (select public.reverse_credit_for_feedback(fb_reversed, 'test reversal') from fx2),
  0,
  'a second reversal is a no-op rather than a double subtraction'
);

reset role;

-- A non-admin cannot reach the reversal at all.
select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select throws_ok(
  $$ select public.reverse_credit_for_feedback(fb_reversed, 'x') from fx2 $$,
  '42501',
  'Admin only',
  'reversal is admin-only'
);

reset role;

-- =============================================================================
-- The ceiling blocks future earning, never the past — and never spending
-- =============================================================================
--
-- Ada's spendable balance is 3. Capping her at 3 means the next earned credit
-- would take her beyond the max, so evaluation must refuse it while leaving
-- every existing row — and her ability to spend down — intact.

insert into public.moderation_actions (actor_id, action, target_type, target_id, meta)
select admin, 'credit_cap_set', 'user', ada::text, jsonb_build_object('max', 3, 'note', 'test ceiling')
  from fx;

insert into public.content_entries
  (author_id, platform, original_url, canonical_url, url_hash, status, published_at)
select bob, 'youtube', 'https://x.test/t05-capped', 'https://x.test/t05-capped',
       extensions.digest('https://x.test/t05-capped', 'sha256'), 'active', now()
  from fx;

update fx2 set entry4 = (select id from public.content_entries where canonical_url = 'https://x.test/t05-capped');

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select (select entry4 from fx2), id, ord - 1
  from (select id, row_number() over (order by slug) as ord from public.hashtags limit 3) t;

select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.mark_entry_opened(entry4) from fx2 $$,
  'ada opens the fourth entry'
);

select lives_ok(
  $$ select public.submit_feedback(entry4,
         'Audience fit is precise and the storytelling earns its length; the clarity of the middle section could still be sharpened.',
         '{audience_fit,storytelling}') from fx2 $$,
  'ada submits feedback on the fourth entry'
);

reset role;

update fx2 set fb_capped = (select id from public.feedback
 where author_id = (select ada from fx) and entry_id = (select entry4 from fx2));

select is(
  (select public.evaluate_feedback_eligibility(fb_capped) from fx2),
  'ineligible'::eligibility_state,
  'earning at the ceiling evaluates ineligible'
);

select is(
  (select eligibility_reason from public.feedback where id = (select fb_capped from fx2)),
  'cap_reached',
  'the ceiling refusal carries its own reason'
);

-- Spending down is the escape hatch: a submission above the cap must succeed.
select set_config('request.jwt.claim.sub', (select ada::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.create_content_entry('youtube', 'https://x.test/t05-spenddown', 'https://x.test/t05-spenddown',
       (select array_agg(id) from (select id from public.hashtags order by slug limit 3) t)) $$,
  'a member above the cap can still spend down by submitting'
);

reset role;

-- =============================================================================
-- No credit without eligible feedback
-- =============================================================================
--
-- A note below the quality gate is still stored (refusing it would be worse
-- product), but it earns nothing — the eligibility gate affects payment, not
-- submission.

insert into public.content_entries
  (author_id, platform, original_url, canonical_url, url_hash, status, published_at)
select ada, 'youtube', 'https://x.test/t05-short', 'https://x.test/t05-short',
       extensions.digest('https://x.test/t05-short', 'sha256'), 'active', now()
  from fx;

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select id, hid, ord - 1
  from (select id from public.content_entries where canonical_url = 'https://x.test/t05-short') e
  cross join (select id as hid, row_number() over (order by slug) as ord from public.hashtags limit 3) t;

select set_config('request.jwt.claim.sub', (select bob::text from fx), true);
set local role authenticated;

select lives_ok(
  $$ select public.mark_entry_opened(id)
       from public.content_entries where canonical_url = 'https://x.test/t05-short' $$,
  'bob opens ada''s entry'
);

select lives_ok(
  $$ select public.submit_feedback(id, 'Nice work, thanks!', '{}')
       from public.content_entries where canonical_url = 'https://x.test/t05-short' $$,
  'bob submits a below-threshold note'
);

reset role;

update fx2 set fb_short = (select id from public.feedback
 where author_id = (select bob from fx)
   and entry_id = (select id from public.content_entries where canonical_url = 'https://x.test/t05-short'));

select is(
  (select eligibility::text from public.feedback where id = (select fb_short from fx2)),
  'ineligible',
  'a below-threshold note is stored but ineligible'
);

select is(
  (select count(*)::integer from public.credit_ledger
    where feedback_id = (select fb_short from fx2)),
  0,
  'ineligible feedback writes no ledger row'
);

select * from finish();
rollback;
