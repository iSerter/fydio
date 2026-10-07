-- =============================================================================
-- pgTAP · 011 — Feedback lifecycle, reporting, and success metrics
-- =============================================================================

begin;

select plan(36);

-- =============================================================================
-- Fixtures
-- =============================================================================

select set_config('t09.creator', gen_random_uuid()::text, true);
select set_config('t09.author',  gen_random_uuid()::text, true);
select set_config('t09.other',   gen_random_uuid()::text, true);
select set_config('t09.admin',   gen_random_uuid()::text, true);
select set_config('t09.entry1',  gen_random_uuid()::text, true);
select set_config('t09.entry2',  gen_random_uuid()::text, true);

insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  (current_setting('t09.creator')::uuid, '00000000-0000-0000-0000-000000000000', 't09-creator@demo.test', '', now(), now(), '{}', '{}'),
  (current_setting('t09.author')::uuid,  '00000000-0000-0000-0000-000000000000', 't09-author@demo.test',  '', now(), now(), '{}', '{}'),
  (current_setting('t09.other')::uuid,   '00000000-0000-0000-0000-000000000000', 't09-other@demo.test',   '', now(), now(), '{}', '{}'),
  (current_setting('t09.admin')::uuid,   '00000000-0000-0000-0000-000000000000', 't09-admin@demo.test',   '', now(), now(), '{}', '{}')
on conflict (id) do nothing;

update public.profiles
   set role = 'admin'
 where id = current_setting('t09.admin')::uuid;

-- Add hashtags to ensure integrity
select set_config('t09.tag1', gen_random_uuid()::text, true);
select set_config('t09.tag2', gen_random_uuid()::text, true);
select set_config('t09.tag3', gen_random_uuid()::text, true);

insert into public.hashtags (id, slug, label, is_official, created_by)
values
  (current_setting('t09.tag1')::uuid, 'tag-one-t09', 'Tag One T09', true, current_setting('t09.admin')::uuid),
  (current_setting('t09.tag2')::uuid, 'tag-two-t09', 'Tag Two T09', true, current_setting('t09.admin')::uuid),
  (current_setting('t09.tag3')::uuid, 'tag-three-t09', 'Tag Three T09', true, current_setting('t09.admin')::uuid)
on conflict do nothing;

insert into public.content_entries (
  id, author_id, platform, original_url, canonical_url, url_hash,
  title, preview_state, status, published_at, created_at
)
values (
  current_setting('t09.entry1')::uuid, current_setting('t09.creator')::uuid, 'youtube',
  'https://www.youtube.com/watch?v=t09fixture1', 'https://www.youtube.com/watch?v=t09fixture1',
  extensions.digest('https://www.youtube.com/watch?v=t09fixture1', 'sha256'),
  'T09 fixture entry 1', 'resolved', 'active', now(), now()
), (
  current_setting('t09.entry2')::uuid, current_setting('t09.creator')::uuid, 'youtube',
  'https://www.youtube.com/watch?v=t09fixture2', 'https://www.youtube.com/watch?v=t09fixture2',
  extensions.digest('https://www.youtube.com/watch?v=t09fixture2', 'sha256'),
  'T09 fixture entry 2', 'resolved', 'active', now(), now()
);

insert into public.content_hashtags (content_entry_id, hashtag_id, position)
values
  (current_setting('t09.entry1')::uuid, current_setting('t09.tag1')::uuid, 0),
  (current_setting('t09.entry1')::uuid, current_setting('t09.tag2')::uuid, 1),
  (current_setting('t09.entry1')::uuid, current_setting('t09.tag3')::uuid, 2),
  (current_setting('t09.entry2')::uuid, current_setting('t09.tag1')::uuid, 0),
  (current_setting('t09.entry2')::uuid, current_setting('t09.tag2')::uuid, 1),
  (current_setting('t09.entry2')::uuid, current_setting('t09.tag3')::uuid, 2);

-- Record opened feed impressions so submit_feedback accepts the submissions
insert into public.feed_impressions (entry_id, viewer_id, opened, served_at)
values
  (current_setting('t09.entry1')::uuid, current_setting('t09.author')::uuid, true, now()),
  (current_setting('t09.entry2')::uuid, current_setting('t09.author')::uuid, true, now());

-- =============================================================================
-- Structure & Storage
-- =============================================================================

select has_function('public', 'can_edit_feedback', array['uuid'], 'can_edit_feedback exists');
select has_function('public', 'update_feedback', array['uuid', 'text', 'feedback_tag[]', 'text[]'], 'update_feedback exists');
select has_function('public', 'remove_feedback', array['uuid'], 'remove_feedback exists');
select has_function('public', 'report_content', array['report_target', 'text', 'text', 'text'], 'report_content exists');
select has_view('public', 'weekly_engagement_dashboard', 'weekly_engagement_dashboard view exists');
select has_view('public', 'member_retention_cohorts', 'member_retention_cohorts view exists');

select ok(
  exists (select 1 from storage.buckets where id = 'feedback-images'),
  'feedback-images bucket is provisioned'
);

-- =============================================================================
-- Feedback Submission & can_edit_feedback boundaries
-- =============================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.author'), true);

select lives_ok(
  format(
    $$select public.submit_feedback('%s'::uuid, 'This is a high quality feedback critique with more than forty chars.', array['hook']::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.entry1')
  ),
  't09.author submits feedback on entry 1'
);

select set_config(
  't09.fb1',
  (select id::text from public.feedback where entry_id = current_setting('t09.entry1')::uuid and author_id = current_setting('t09.author')::uuid),
  true
);

-- Author can edit unrated feedback within grace
select is(
  public.can_edit_feedback(current_setting('t09.fb1')::uuid),
  true,
  'author can edit fresh unrated feedback'
);

-- Other member cannot edit
select set_config('request.jwt.claim.sub', current_setting('t09.other'), true);
select is(
  public.can_edit_feedback(current_setting('t09.fb1')::uuid),
  false,
  'non-author cannot edit feedback'
);

-- Attempting update as other fails
select throws_ok(
  format(
    $$select public.update_feedback('%s'::uuid, 'Attempted hijack of feedback body.', '{}'::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.fb1')
  ),
  '42501',
  'You can only edit your own feedback',
  'non-author update_feedback is rejected'
);

-- =============================================================================
-- update_feedback: content updates, eligibility, and credit reversals
-- =============================================================================

-- As author, evaluate eligibility so credit is held
set local role postgres;
select public.evaluate_feedback_eligibility(current_setting('t09.fb1')::uuid);

select is(
  (select count(*)::integer from public.credit_ledger where feedback_id = current_setting('t09.fb1')::uuid and status = 'held'),
  1,
  'feedback earned 1 held credit'
);

-- Now switch back to author and update feedback
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.author'), true);

select lives_ok(
  format(
    $$select public.update_feedback('%s'::uuid, 'Updated critique text that still satisfies the 40 character quality threshold.', array['clarity']::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.fb1')
  ),
  'author successfully updates feedback'
);

-- Editing reversed the previous held credit
select is(
  (select count(*)::integer from public.credit_ledger where feedback_id = current_setting('t09.fb1')::uuid and status = 'held'),
  0,
  'held credit was reversed on edit'
);

select is(
  (select count(*)::integer from public.credit_ledger where feedback_id = current_setting('t09.fb1')::uuid and status = 'reversed'),
  2,
  'both original and audit reversal rows are marked reversed'
);

select is(
  (select eligibility from public.feedback where id = current_setting('t09.fb1')::uuid),
  'pending'::eligibility_state,
  'eligibility was reset to pending'
);

select is(
  (select tags from public.feedback where id = current_setting('t09.fb1')::uuid),
  array['clarity']::feedback_tag[],
  'tags were updated'
);

-- Update with short body below quality gate marks it ineligible
select lives_ok(
  format(
    $$select public.update_feedback('%s'::uuid, 'Short body!', '{}'::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.fb1')
  ),
  'update with short body succeeds'
);

select is(
  (select eligibility from public.feedback where id = current_setting('t09.fb1')::uuid),
  'ineligible'::eligibility_state,
  'short body is marked ineligible'
);

-- =============================================================================
-- Rating & Edit Blocking
-- =============================================================================

-- Creator rates the feedback
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.creator'), true);

select lives_ok(
  format(
    $$select public.rate_feedback('%s'::uuid, 8::smallint)$$,
    current_setting('t09.fb1')
  ),
  'creator rates feedback 8'
);

-- Check reputation increased
select is(
  (select reputation_total from public.profiles where id = current_setting('t09.author')::uuid),
  8,
  'author reputation increased by 8'
);

-- Now author cannot edit because feedback is rated
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.author'), true);

select is(
  public.can_edit_feedback(current_setting('t09.fb1')::uuid),
  false,
  'can_edit_feedback is false once rated'
);

select throws_ok(
  format(
    $$select public.update_feedback('%s'::uuid, 'Trying to edit rated feedback text.', '{}'::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.fb1')
  ),
  '23514',
  'Rated feedback cannot be edited',
  'update_feedback throws when rated'
);

-- =============================================================================
-- remove_feedback cascades
-- =============================================================================

select lives_ok(
  format($$select public.remove_feedback('%s'::uuid)$$, current_setting('t09.fb1')),
  'author removes their feedback'
);

select is(
  (select removed_at is not null from public.feedback where id = current_setting('t09.fb1')::uuid),
  true,
  'feedback is marked removed'
);

-- Reputation was reversed
select is(
  (select reputation_total from public.profiles where id = current_setting('t09.author')::uuid),
  0,
  'author reputation returned to 0 after feedback removal'
);

-- Second removal attempt is rejected
select throws_ok(
  format($$select public.remove_feedback('%s'::uuid)$$, current_setting('t09.fb1')),
  '23514',
  'Feedback already removed',
  'second removal is rejected'
);

-- =============================================================================
-- Content Reporting & Admin Resolve Cascade
-- =============================================================================

-- Submit feedback on entry 2
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.author'), true);

select lives_ok(
  format(
    $$select public.submit_feedback('%s'::uuid, 'Second feedback critique with plenty of words to qualify.', array['storytelling']::feedback_tag[], '{}'::text[])$$,
    current_setting('t09.entry2')
  ),
  't09.author submits feedback on entry 2'
);

select set_config(
  't09.fb2',
  (select id::text from public.feedback where entry_id = current_setting('t09.entry2')::uuid and author_id = current_setting('t09.author')::uuid),
  true
);

set local role postgres;
select public.evaluate_feedback_eligibility(current_setting('t09.fb2')::uuid);

-- Rate it
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.creator'), true);
select public.rate_feedback(current_setting('t09.fb2')::uuid, 9::smallint);

-- Other member reports feedback 2 as abusive
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.other'), true);

select lives_ok(
  format(
    $$select public.report_content('feedback'::report_target, '%s', 'Abusive content in feedback critique')$$,
    current_setting('t09.fb2')
  ),
  't09.other reports feedback 2'
);

select set_config(
  't09.report',
  (select id::text from public.moderation_reports where target_type = 'feedback' and target_id = current_setting('t09.fb2')),
  true
);

-- Self-reporting is blocked
select set_config('request.jwt.claim.sub', current_setting('t09.creator'), true);

select throws_ok(
  format(
    $$select public.report_content('content_entry'::report_target, '%s', 'Reporting my own entry')$$,
    current_setting('t09.entry1')
  ),
  '23514',
  'You cannot report your own entry',
  'self-reporting entry is rejected'
);

-- Admin resolves report as abusive
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t09.admin'), true);

select lives_ok(
  format(
    $$select public.admin_resolve_report('%s'::uuid, 'resolved'::report_state, 'Abuse confirmed')$$,
    current_setting('t09.report')
  ),
  'admin resolves report'
);

-- Verify cascading effects: feedback removed, credit reversed, reputation reversed
select is(
  (select removed_at is not null from public.feedback where id = current_setting('t09.fb2')::uuid),
  true,
  'reported feedback was soft-removed by admin resolution'
);

select is(
  (select count(*)::integer from public.credit_ledger where feedback_id = current_setting('t09.fb2')::uuid and status = 'held'),
  0,
  'held credit reversed by admin resolution'
);

select is(
  (select reputation_total from public.profiles where id = current_setting('t09.author')::uuid),
  0,
  'reputation reversed to 0 by admin resolution'
);

-- =============================================================================
-- Metrics Views
-- =============================================================================

select lives_ok(
  $$select * from public.weekly_engagement_dashboard order by week_start desc limit 4$$,
  'weekly_engagement_dashboard is queryable'
);

select lives_ok(
  $$select * from public.member_retention_cohorts limit 4$$,
  'member_retention_cohorts is queryable'
);

select * from finish();
rollback;
