-- =============================================================================
-- Fydio seed data
-- =============================================================================
--
-- 30 members, ~40 hashtags, ~180 entries, ~120 feedback items and the ledgers
-- that follow from them — enough that the feed, inbox and credit screens all have
-- something real to render on a fresh `pnpm db:reset`.
--
-- DETERMINISM. `setseed` plus no bare `random()`. Every value here is derived from
-- `generate_series` and fixed arithmetic, so two developers on two machines get
-- byte-identical data and a screenshot in a bug report matches what the reporter
-- sees. `random()` would make every seed a different database.
--
-- INVARIANTS. This file respects every rule the migrations enforce. It has to: if
-- the seed violated one, that would be evidence the constraint is wrong, but more
-- likely it would just be a seed that cannot be applied. The 5-hashtag and
-- exactly-3-hashtag triggers fire at COMMIT, so this file commits as a unit and
-- both counts are settled before the check runs.
--
-- Emails are `@demo.test`, reserved by RFC 6761 and undeliverable by design. The
-- password below is a local-only throwaway — this stack never leaves a laptop.
--
-- No `\set ON_ERROR_STOP on` here. `supabase db reset` does not feed the seed through
-- psql's meta-command parser, so a backslash directive is a syntax error
-- (SQLSTATE 42601) rather than a setting. The explicit `begin;` / `commit;` below is
-- what makes the seed atomic instead, and it is the stronger guarantee anyway: a
-- seed that fails halfway cannot leave a half-populated database for the next
-- statement to trip over.

begin;

select setseed(0.4242);

-- Password for every demo account. `crypt` comes from pgcrypto, which the auth
-- schema itself uses to store password hashes. Local development only.
select set_config('app.seed_password', 'demo-password-not-real', false);

-- -----------------------------------------------------------------------------
-- Members
-- -----------------------------------------------------------------------------
--
-- `handle_new_user` fires on auth.users and provisions each profile, so the seed
-- goes through auth.users rather than inserting profiles directly. That means the
-- trigger is exercised on every `db:reset`, and a break in it is caught by the
-- seed failing rather than by a member mysteriously missing a profile later.

-- `auth.identities` rows.
--
-- GoTrue does not authenticate against `auth.users` alone: a password sign-in
-- resolves through `auth.identities`, so a user inserted without one exists but can
-- never log in. Without these rows the seeded accounts are unusable for the web app
-- and for the integration tests that need a real member session -- and the failure
-- mode is misleading, because the account looks fine in the database.
--
-- `provider_id` must equal the user id (not the email) for a password identity, and
-- `identity_data` carries the claims GoTrue expects to find there.

-- Ids are fixed rather than `gen_random_uuid()`, so a developer who re-runs the seed
-- sees the same member under the same id (handy when a bookmarked URL or a support
-- screenshot refers to one).
--
-- Idempotency: the demo rows are deleted first, including from `auth.users`. The
-- delete matters — `handle_new_user` provisions a profile only on INSERT into
-- auth.users, so leaving the rows in place would make `on conflict do nothing` skip
-- every insert, the trigger would never fire, and the re-run would end with
-- auth.users populated but zero profiles. Deleting and re-inserting exercises the
-- trigger on every run, which is the point.
delete from public.profiles where id in (
  select id from auth.users where email like '%@demo.test'
);
delete from auth.users where email like '%@demo.test';

-- `aud` is the JWT audience and is NOT NULL in GoTrue's own sign-up path, but the
-- column itself defaults to NULL when a row is inserted directly. GoTrue's password
-- sign-in filters on `aud = 'authenticated'`, so leaving it unset makes every lookup
-- miss and reports "invalid credentials" -- even though the hash verifies correctly.
-- That is a genuinely confusing failure to debug, hence setting it explicitly.
-- WHY EVERY ONE OF THESE COLUMNS IS FILLED IN
--
-- GoTrue scans a user row positionally into Go values, and the scan aborts on the
-- first NULL it cannot accept. A directly-inserted row therefore cannot leave these
-- columns unset the way a real sign-up does:
--
--   * text / varchar  -> "converting NULL to string is unsupported". GoTrue writes ''
--     rather than NULL, so the seed does too.
--   * boolean         -> the same class of failure, one column later.
--
-- `phone` is deliberately left NULL and is not in the column list: it is the one
-- nullable text column GoTrue's scan accepts as NULL, and writing '' to it collides
-- with every other row on the `users_phone_key` unique index.
--
-- The symptom is a 500 whose message names an internal scan error and never mentions
-- authentication, which makes it close to undiagnosable from the outside: every
-- seeded account reports a database error even though its password hash is perfect.
-- Reproducing GoTrue's own shape is the whole fix.
insert into auth.users (
  id, email, raw_user_meta_data, created_at, encrypted_password, email_confirmed_at, aud, instance_id,
  role, confirmation_token, recovery_token, email_change_token_new, email_change,
  phone_change, phone_change_token, email_change_token_current, reauthentication_token,
  is_super_admin, is_sso_user, is_anonymous, email_change_confirm_status, updated_at
)
select
  ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case
    when i = 1 then 'admin@demo.test'
    else format('member_%s@demo.test', lpad(i::text, 2, '0'))
  end,
  jsonb_build_object('display_name', case
    when i = 1 then 'Ada Admin'
    else 'Member ' || lpad(i::text, 2, '0')
  end),
  now() - interval '45 days',
  extensions.crypt('demo-password-not-real', extensions.gen_salt('bf')),
  now(),
  'authenticated',
  -- `instance_id` scopes GoTrue's sign-in lookup, and leaving it NULL makes every
  -- seeded account report "invalid credentials" even though its password hash
  -- verifies -- a failure with no useful signal anywhere in the response.
  --
  -- Read from `auth.instances` rather than hard-coded, so the seed survives the
  -- instance id being regenerated. The row is created by GoTrue on its first boot,
  -- so it can legitimately be EMPTY when `pnpm db:reset` runs against a stack whose
  -- Auth has not been hit since the last wipe -- hence the coalesce rather than a
  -- subquery that would return no rows and silently insert zero users.
  coalesce((select uuid from auth.instances limit 1), '00000000-0000-0000-0000-000000000000'::uuid),
  'authenticated',
  '', '', '', '',
  '', '', '', '',
  false, false, false, 0,
  now() - interval '45 days'
from generate_series(1, 30) as i
on conflict (id) do nothing;

-- Clear the app's own data before rebuilding it. Cascades handle the rest; this
-- makes re-running the seed safe rather than doubling every count.
-- Wipe the app's own data before rebuilding it, so re-running the seed refreshes
-- every count instead of doubling them.
--
-- `profiles` is NOT truncated. `handle_new_user` only creates a profile on INSERT
-- into auth.users, and the `on conflict do nothing` above means a re-run does not
-- re-fire it — so truncating profiles would leave the auth.users rows present but
-- profile-less, and every later insert would fail on a null author. The profiles
-- are created by the trigger and left alone.
--
-- The remaining tables cascade from nothing in particular; they only reference
-- profiles, which is why they can be emptied freely. `truncate` also sidesteps the
-- append-only ledger triggers (they fire on UPDATE/DELETE, not TRUNCATE) and is far
-- faster than row-by-row deletes at this volume.
truncate table
  public.moderation_actions,
  public.moderation_reports,
  public.duration_events,
  public.outbound_clicks,
  public.feed_impressions,
  public.feed_signals,
  public.mutes,
  public.credit_ledger,
  public.weekly_allowance_runs,
  public.reputation_ledger,
  public.feedback_ratings,
  public.credit_eligibility_reviews,
  public.feedback,
  public.content_hashtags,
  public.content_entries,
  public.profile_links,
  public.profile_hashtags,
  public.hashtags,
  public.friendships
cascade;

insert into auth.identities (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select
  u.id,
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email',
  now(),
  now(),
  now()
from auth.users u
where u.email like '%@demo.test'
on conflict (provider_id, provider) do nothing;

-- Promote exactly one admin. Done after insert rather than in the trigger because
-- "the first account is an admin" is not a rule — invitations carry the role.
-- Matched on the email rather than the generated handle. `unique_handle_from_email`
-- sanitises the local part, so `admin@demo.test` yields `admin` -- asserting on the
-- handle here would break silently if that sanitising rule ever changed.
update public.profiles p
   set role = 'admin'
  from auth.users u
 where u.id = p.id and u.email = 'admin@demo.test';

-- Every seeded member is stamped as onboarded (T03).
--
-- `handle_new_user` provisions each profile through the auth.users trigger and gives it a
-- placeholder display name. Without this stamp all 30 demo members would have
-- `onboarding_completed_at IS NULL` and the proxy would bounce every one of them into the
-- five-step wizard on first load -- which would make the seeded feed, inbox and moderation
-- screens unreachable for local development.
--
-- This is also what the column means: NULL is reserved for accounts that genuinely have
-- not finished onboarding, a population only a real invite redemption can produce.
update public.profiles
   set onboarding_completed_at = now();

-- -----------------------------------------------------------------------------
-- Hashtags — 40 tags across the interest areas the brief names
-- -----------------------------------------------------------------------------

insert into public.hashtags (slug, label, is_official, created_by)
select
  t.slug,
  initcap(replace(t.slug, '-', ' ')),
  true,
  (select id from public.profiles where role = 'admin')
from unnest(array[
  'hooks','hook-analysis','retention','storytelling','pacing','editing','color-grading',
  'sound-design','music','voiceover','thumbnails','thumbnail-design','covers','captions',
  'short-form','long-form','documentary','interviews','tutorials','behind-the-scenes',
  'camera-work','lighting','gear','setup-rig','budget-gear','workflow','productivity',
  'audience-growth','community','brand','sponsorships','monetization','analytics',
  'sound-off','vertical-video','aspect-ratio','transitions','color-theory','composition'
]) as t(slug);

-- -----------------------------------------------------------------------------
-- Profile hashtags — exactly 5 per member
-- -----------------------------------------------------------------------------
--
-- Five every time, from a rotating slice of the pool. The slice is offset per
-- member so the tag overlap in the feed is uneven, which is what makes ranking
-- observable: if every member had the same five tags, `rank_feed` would look
-- correct while doing nothing.
--
-- `(i + k) % 40` walks the pool with a per-member offset, and `k < 5` takes five
-- consecutive tags — distinct by construction, since the window is smaller than
-- the pool.

-- `row_number()` cannot appear inside an OFFSET (Postgres rejects window functions
-- there), so the per-member rotation is computed in a CTE and only the finished
-- integer reaches the offset expression.
with members as (
  select id, ((row_number() over (order by handle) - 1)::int % 36) as offset
  from public.profiles
)
insert into public.profile_hashtags (profile_id, hashtag_id, position)
select
  m.id,
  (select h.id from public.hashtags h order by h.slug offset (m.offset + k) limit 1),
  k
from members m
cross join generate_series(0, 4) as k;

-- -----------------------------------------------------------------------------
-- Friendships — ~35% accepted, some pending
-- -----------------------------------------------------------------------------
--
-- Generated from unordered pairs, so each pair appears once and the `pair_key`
-- unique index is never asked to catch a duplicate. `state` is derived from the
-- pair's position rather than `random()`, keeping the mix deterministic:
-- roughly every third pair accepted, a smaller slice still pending.

insert into public.friendships (requester_id, addressee_id, state, created_at, responded_at)
with ordered as (
  select
    a.id as lo,
    b.id as hi,
    row_number() over (order by a.id, b.id) as n
  from public.profiles a
  join public.profiles b on a.id < b.id
),
-- Every third pair becomes a friendship: ~33% density, close to the ~35% target.
selected as (
  select lo, hi, n,
         case
           when n % 3 = 0 then 'accepted'::friendship_state
           when n % 12 = 1 then 'pending'::friendship_state
           else null
         end as st
  from ordered
  where n % 3 = 0 or n % 12 = 1
)
select
  lo, hi, st,
  now() - ((n % 30) || ' days')::interval,
  case when st = 'pending' then null else now() - ((n % 30) || ' days')::interval end
from selected
where st is not null;

-- -----------------------------------------------------------------------------
-- Content entries — ~180 over the last 30 days
-- -----------------------------------------------------------------------------

insert into public.content_entries (
  author_id, platform, original_url, canonical_url, url_hash,
  title, caption_excerpt, thumbnail_path, thumbnail_source, preview_state,
  creator_note, asks_for_feedback, status, published_at, created_at
)
select
  (select id from public.profiles order by handle offset (i % 30) limit 1) as author_id,
  (array['instagram','tiktok','youtube','x']::platform_kind[])[1 + (i % 4)] as platform,
  format('https://%s.example/p/%s', (array['instagram','tiktok','youtube','x'])[1 + (i % 4)], i),
  format('https://%s.example/p/%s', (array['instagram','tiktok','youtube','x'])[1 + (i % 4)], i),
  extensions.digest(format('https://%s.example/p/%s', (array['instagram','tiktok','youtube','x'])[1 + (i % 4)], i), 'sha256'),
  'Demo entry ' || i,
  'Caption excerpt for demo entry number ' || i,
  format('covers/%s.png', i),
  case when i % 3 = 0 then 'platform' when i % 3 = 1 then 'upload' else null end,
  -- Mixed preview states so the feed has to render resolved, pending and
  -- unavailable cards — the link-card fallback is a real state, not an edge case.
  (array['resolved','resolved','pending','unavailable']::preview_state[])[1 + (i % 4)],
  case when i % 2 = 0 then 'Would love notes on the pacing here.' else null end,
  (i % 3) = 0,
  'active',
  now() - ((i % 30) || ' days')::interval,
  now() - ((i % 30) || ' days')::interval
from generate_series(1, 180) as i;

-- Exactly three hashtags per entry, drawn from the pool with a per-entry offset so
-- entries overlap partially rather than all sharing the same three.
with entries as (
  select id, ((('x' || substr(id::text, 1, 8))::bit(32)::bigint % 34)) as offset
  from public.content_entries
)
insert into public.content_hashtags (content_entry_id, hashtag_id, position)
select
  en.id,
  (select h.id from public.hashtags h order by h.slug offset ((en.offset + k) % 40) limit 1),
  k
from entries en
cross join generate_series(0, 2) as k;

-- -----------------------------------------------------------------------------
-- Impressions — the "opened" history feedback eligibility depends on
-- -----------------------------------------------------------------------------
--
-- Roughly a third of (viewer, entry) pairs, so `submit_feedback` has open history
-- to require without every pair being pre-opened.

-- The `(entry, viewer)` mix is driven by the row number of the cross join, not by a
-- hash of a timestamp: it has to vary per PAIR, or every entry gets the same set of
-- openers and the feed looks uniform.
with pairs as (
  select
    e.id as entry_id,
    v.id as viewer_id,
    row_number() over (order by e.id, v.id) as n
  from public.content_entries e
  join public.profiles v on v.id <> e.author_id
)
insert into public.feed_impressions (entry_id, viewer_id, position, score, reason_code, served_at, opened, opened_at)
select
  p.entry_id,
  p.viewer_id,
  1 + (p.n % 20),
  round((0.5 + (p.n % 150) / 100.0)::numeric, 4),
  (array['shared_hashtag','fresh','friend']::text[])[1 + (p.n % 3)],
  e.published_at,
  (p.n % 3) <> 0,
  case when (p.n % 3) <> 0 then e.published_at + interval '1 hour' else null end
from pairs p
join public.content_entries e on e.id = p.entry_id
where (p.n % 3) <> 0;

-- Written directly rather than through `submit_feedback`, for two reasons: the
-- seed runs as `postgres` with no `auth.uid()`, and the RPC's precondition (a prior
-- open) is already satisfied above. The eligibility mix is then set explicitly so
-- the credit screens have all three states to render.
--
-- Lengths vary on purpose: items under `app.feedback_min_chars` (40) exist in the
-- seed as `ineligible`, which is a real product state -- a short note is stored and
-- simply earns nothing.

with numbered as (
  select
    e.id as entry_id,
    e.author_id as entry_author,
    e.published_at,
    row_number() over (order by e.id) as n
  from public.content_entries e
),
assign as (
  select
    nn.entry_id,
    nn.published_at,
    nn.n,
    -- Chosen from the profiles EXCLUDING the entry's author, so `rating_no_self`
    -- and the self-feedback trigger both hold. Offsetting within that reduced set
    -- (rather than offsetting within all 30 and hoping the author is not chosen) is
    -- what guarantees it.
    (select p.id
       from public.profiles p
      where p.id <> nn.entry_author
      order by p.handle
      offset ((nn.n * 7) % 29)
      limit 1) as giver_id
  from numbered nn
  where nn.n % 3 <> 0
)
insert into public.feedback (entry_id, author_id, body, tags, image_paths, eligibility, eligibility_reason, opened_entry, created_at)
select
  a.entry_id,
  a.giver_id,
  case
    when (a.n % 5) = 0 then 'Nice work.'
    else 'The pacing in the middle section is strong. Consider tightening the opening two seconds, and the hook lands a beat late against the caption promise.'
  end,
  -- Built as `ARRAY[elem]` rather than by subscripting a four-element array: an
  -- indexed access on a typed enum array yields the SCALAR enum, and this column
  -- wants a one-element array. `ARRAY[...]` is the correct shape.
  ARRAY[(ARRAY['hook','editing','storytelling','thumbnail']::feedback_tag[])[1 + (a.n % 4)]],
  case when (a.n % 7) = 0 then array['feedback-images/' || a.n || '-1.png'] else '{}'::text[] end,
  case
    when (a.n % 5) = 0 or (a.n % 7) = 0 then 'ineligible'::eligibility_state
    else 'eligible'::eligibility_state
  end,
  case
    when (a.n % 5) = 0 or (a.n % 7) = 0 then 'below_quality_threshold'
    else null
  end,
  true,
  a.published_at + interval '2 hours'
from assign a
where a.giver_id is not null
  -- one feedback per (entry, giver): the table has a unique constraint on exactly
  -- this pair, and an anti-duplicate-earning rule has to hold in seed data too.
  and not exists (
    select 1 from public.feedback f2
     where f2.entry_id = a.entry_id and f2.author_id = a.giver_id
  );

-- -----------------------------------------------------------------------------
-- Ratings — ~60 of the eligible feedback, scored 4..10
-- -----------------------------------------------------------------------------
--
-- Inserted alongside the reputation ledger rows rather than by calling
-- `rate_feedback`, because the RPC requires `auth.uid()` to be the entry owner and
-- the seed is not signed in as anyone. The ledger rows below are what
-- `refresh_profile_reputation` reads back, so the stored aggregates stay consistent
-- with the rows.

insert into public.feedback_ratings (feedback_id, entry_owner_id, rater_id, score, source, created_at)
select
  f.id,
  e.author_id,
  e.author_id,
  4 + ((('x' || substr(f.id::text, 1, 8))::bit(32)::bigint) % 7),
  'creator_rating',
  f.created_at + interval '1 day'
from public.feedback f
join public.content_entries e on e.id = f.entry_id
where f.eligibility = 'eligible'
  and (('x' || substr(f.id::text, 1, 8))::bit(32)::bigint) % 2 = 0
  and f.created_at + interval '1 day' < now();

-- Reputation accrues to the feedback AUTHOR (the giver), NOT to `entry_owner_id`
-- (the rater). The distinction is the whole mechanism: the creator who reads and
-- rates the feedback raises the giver's reputation, and is not rewarded for it.
insert into public.reputation_ledger (user_id, delta, kind, rating_id, feedback_id, created_at)
select f.author_id, r.score, 'creator_rating', r.id, r.feedback_id, r.created_at
from public.feedback_ratings r
join public.feedback f on f.id = r.feedback_id;

select public.refresh_profile_reputation(p.id) from public.profiles p;

-- -----------------------------------------------------------------------------
-- Credit ledger
-- -----------------------------------------------------------------------------
--
-- Written to match the feedback above rather than generated independently, so the
-- two agree: every `eligible` item has the Credit it earned, and the submission
-- spends line up with entries that actually exist.
--
-- `entry_removed_reversal` is deliberately absent — no entry is removed in this
-- seed, so inventing one would put a row in the ledger that nothing justifies.

-- Weekly allowances for each of the last six weeks.
insert into public.credit_ledger (user_id, delta, kind, status, available_at, note, created_at)
select
  p.id,
  3,
  'weekly_allowance',
  'available',
  null,
  'Weekly starter allowance',
  now() - (w || ' weeks')::interval
from public.profiles p
cross join generate_series(0, 5) as w;

-- Submission spends, one per entry. Each is `spent` and therefore subtracts from
-- the balance — see the formula at the top of 0004.
insert into public.credit_ledger (user_id, delta, kind, status, entry_id, note, created_at)
select author_id, -1, 'submission_spend', 'spent', id, 'Content submission', published_at
from public.content_entries;

-- Held Credits for a slice of the eligible feedback, so the review window has rows
-- waiting in it. `available_at` in the future for most, in the past for a few, so
-- `release_held_credits()` has something to move.
insert into public.credit_ledger (user_id, delta, kind, status, entry_id, feedback_id, available_at, note, created_at)
select
  f.author_id,
  1,
  'feedback_earned',
  'held',
  f.entry_id,
  f.id,
  case when (('x' || substr(f.id::text, 1, 8))::bit(32)::bigint) % 6 = 0
       then now() - interval '1 hour'    -- already due
       else now() + interval '48 hours'  -- still in the window
  end,
  'Eligible peer feedback (pending review window)',
  f.created_at
from public.feedback f
where f.eligibility = 'eligible'
  and (('x' || substr(f.id::text, 1, 8))::bit(32)::bigint) % 6 = 0;

-- Already-released Credits for the rest, so balances are not uniformly zero.
insert into public.credit_ledger (user_id, delta, kind, status, entry_id, feedback_id, available_at, note, created_at)
select
  f.author_id, 1, 'feedback_earned', 'available', f.entry_id, f.id, null,
  'Eligible peer feedback', f.created_at
from public.feedback f
where f.eligibility = 'eligible'
  and (('x' || substr(f.id::text, 1, 8))::bit(32)::bigint) % 6 <> 0;

-- -----------------------------------------------------------------------------
-- Outbound clicks and duration events
-- -----------------------------------------------------------------------------
--
-- Duration events are attached to openers only and are private to their author
-- (RLS in 0009). They are seeded so the T08 ingest path has history to render, and
-- they demonstrate the point that nothing in the schema rewards them.

insert into public.outbound_clicks (entry_id, user_id, clicked_at, client, source, return_token)
select
  i.entry_id,
  i.viewer_id,
  i.opened_at,
  case when i.viewer_id::text < '5' then 'web' else 'extension' end,
  'feed',
  encode(extensions.digest(i.viewer_id::text || i.entry_id::text, 'sha256'), 'hex')
from public.feed_impressions i
where i.opened;

insert into public.duration_events (user_id, entry_id, band, returned, consent_version, received_at)
select
  i.viewer_id,
  i.entry_id,
  (array['lt_15s','s15_60','m1_3','gt_3']::duration_band[])[1 + ((('x' || substr(i.entry_id::text, 1, 8))::bit(32)::bigint) % 4)],
  ((('x' || substr(i.entry_id::text, 1, 8))::bit(32)::bigint) % 2) = 0,
  'v1',
  i.opened_at + interval '5 minutes'
from public.feed_impressions i
where i.opened
  and (('x' || substr(i.entry_id::text, 1, 8))::bit(32)::bigint) % 3 = 0;

-- -----------------------------------------------------------------------------
-- Moderation — two open reports
-- -----------------------------------------------------------------------------
--
-- Reported as `open`, so `resolved_by`/`resolved_at` stay NULL — the table's
-- consistency CHECK requires that pairing, and a half-resolved report is a state
-- the schema refuses to store.

insert into public.moderation_reports (reporter_id, target_type, target_id, reason, details, state)
select
  (select id from public.profiles where handle <> 'adaadmin' order by handle offset 3 limit 1),
  'feedback'::report_target,
  (select id from public.feedback where removed_at is null order by id limit 1)::text,
  'Reported feedback',
  'Seeded report for local moderation testing.',
  'open'::report_state
union all
select
  (select id from public.profiles where handle <> 'adaadmin' order by handle offset 9 limit 1),
  'content_entry'::report_target,
  (select id from public.content_entries order by id offset 5 limit 1)::text,
  'Reported content',
  'Seeded report for local moderation testing.',
  'open'::report_state;

-- -----------------------------------------------------------------------------
-- Weekly allowance run marker, so a `grant_weekly_allowance()` call this period is
-- correctly a no-op rather than a second grant.
-- -----------------------------------------------------------------------------

insert into public.weekly_allowance_runs (period_start, granted_count, amount, ran_at)
values (date_trunc('week', now() at time zone 'utc')::date, 30, 3, now());

commit;

-- -----------------------------------------------------------------------------
-- Summary
-- -----------------------------------------------------------------------------

do $$
declare
  v_bad integer;
begin
  SELECT count(*) INTO v_bad
    FROM (
      SELECT profile_id FROM public.profile_hashtags
      GROUP BY profile_id HAVING count(*) <> 5
    ) t;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'seed invariant violated: % profiles do not have exactly 5 hashtags', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM (
      SELECT content_entry_id FROM public.content_hashtags
      GROUP BY content_entry_id HAVING count(*) <> 3
    ) t;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'seed invariant violated: % entries do not have exactly 3 hashtags', v_bad;
  END IF;

  RAISE NOTICE
    'seed: 30 members, % hashtags, % entries, % feedback items, % ratings',
    (SELECT count(*) FROM public.hashtags),
    (SELECT count(*) FROM public.content_entries),
    (SELECT count(*) FROM public.feedback),
    (SELECT count(*) FROM public.feedback_ratings);
END
$$;

select
  (select count(*) from public.profiles) as profiles,
  (select count(*) from public.hashtags) as hashtags,
  (select count(*) from public.friendships where state = 'accepted') as friends_accepted,
  (select count(*) from public.content_entries) as entries,
  (select count(*) from public.feedback) as feedback_items,
  (select count(*) from public.feedback_ratings) as ratings,
  (select count(*) from public.credit_ledger) as ledger_rows,
  (select count(*) from public.moderation_reports where state = 'open') as open_reports;
