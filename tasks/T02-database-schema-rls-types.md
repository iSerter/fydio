# T02 — Database Schema, Migrations, RLS & Generated Types

**Status:** Not started
**Depends on:** T01
**Blocks:** T03, T04, T05, T06, T07, T08, T09
**Brief reference:** "Core entities" list, §2 Credits and submission access, §4 Curated home feed, §7 Feedback, §8 Reputation, §9 Credit safeguards.

---

## 1. Goal

Create the **entire** Postgres schema as ordered SQL migrations, with RLS policies, triggers, indexes, and `SECURITY DEFINER` RPCs that enforce every business rule from the brief at the database layer — so no client can bypass them.

After T02 the app can be built entirely against RPCs, and every credit/reputation invariant in the brief is provable with SQL.

---

## 2. Why this position in the plan

Schema first means T03–T09 are feature work, not schema negotiation. It also forces the credits-vs-reputation separation to be structural — two ledgers, two sets of RPCs, no shared enum — rather than a UI convention that could erode later.

---

## 3. Scope

### In scope

- `supabase/migrations/` — full DDL, triggers, RLS, functions
- All core entities plus supporting tables
- RPCs: entry creation, feedback creation, rating, feed ranking, credit ops, admin ops
- Indexes tuned for feed and inbox queries
- `supabase/seed.sql` with realistic dev fixtures (30 members, ~180 entries, tags, friendships)
- Generated TypeScript types (`@fydio/supabase`)
- pgTAP tests for every invariant

### Explicitly out of scope

- Any UI
- Edge Functions (T04 preview resolver, T08 telemetry ingest, T10 sweeper)
- Real auth UX — only the trigger that provisions a profile row (T03 builds the flows)

---

## 4. Deliverables

1. 11 migrations under `supabase/migrations/`, each independently revertible
2. All tables, enums, constraints, indexes, triggers
3. RLS enabled on **every** table with explicit policies (no "enable RLS and hope")
4. ~20 `SECURITY DEFINER` RPCs
5. `supabase/seed.sql` — deterministic fixtures
6. Generated `Database` TypeScript types
7. pgTAP suite proving each brief invariant
8. `supabase/tests/` runnable via `supabase test db`

---

## 5. Technical design

### 5.1 Enums

```sql
create type platform_kind   as enum ('instagram','tiktok','youtube','x');
create type profile_role    as enum ('member','admin');
create type friendship_state as enum ('pending','accepted','declined','blocked');
create type entry_state     as enum ('active','hidden','removed');
create type preview_state   as enum ('pending','resolved','unavailable','failed');

create type credit_kind as enum (
  'weekly_allowance','feedback_earned','submission_spend',
  'admin_grant','admin_reverse','hold_release','hold_reversal','entry_removed_reversal'
);
create type reputation_kind as enum (
  'creator_rating','rating_revision','moderation_reversal'
);
create type ledger_status as enum ('held','available','spent','reversed');
create type eligibility_state as enum ('pending','eligible','ineligible','held','reversed','removed');
create type feedback_tag as enum ('hook','clarity','editing','storytelling','thumbnail','cta','audience_fit');
create type duration_band as enum ('lt_15s','s15_60','m1_3','gt_3','unknown');
create type report_state as enum ('open','reviewing','resolved','dismissed');
create type report_target as enum ('user','content_entry','feedback','hashtag');
```

> `credit_kind` and `reputation_kind` are **separate enums**. Sharing one would invite exactly the "points" conflation the brief forbids, and would let a developer write `kind = 'feedback_earned'` inside a reputation insert without the compiler complaining.

### 5.2 Table inventory

| Table                        | Purpose                          | Notable columns                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invites`                    | Invite-only gate                 | `email citext unique`, `token_hash`, `role`, `invited_by`, `accepted_at`, `expires_at`, `revoked_at`                                                                                                                                                                                      |
| `profiles`                   | Public member identity           | `id uuid PK references auth.users`, `handle citext unique`, `display_name`, `bio`, `avatar_path`, `role`, `reputation_total int default 0`, `rated_feedback_count int default 0`, `reputation_avg numeric(3,2)`, `created_at`, `last_seen_at`                                             |
| `hashtags`                   | Global tag vocabulary            | `slug citext unique`, `label`, `usage_count int`, `is_official bool`, `created_by`                                                                                                                                                                                                        |
| `profile_hashtags`           | ≤5 per profile                   | `profile_id`, `hashtag_id`, `position smallint`, PK both                                                                                                                                                                                                                                  |
| `profile_links`              | Connected public handles         | `profile_id`, `platform platform_kind`, `url`, `label`                                                                                                                                                                                                                                    |
| `friendships`                | Mutual connections               | `requester_id`, `addressee_id`, `state friendship_state`, `created_at`, `responded_at`, normalized `pair_key` unique                                                                                                                                                                      |
| `content_entries`            | Submitted content                | `author_id`, `platform`, `original_url`, `canonical_url`, `url_hash`, `title`, `caption_excerpt`, `thumbnail_path`, `thumbnail_source`, `preview_state`, `preview_meta jsonb`, `creator_note`, `asks_for_feedback bool`, `status entry_state`, `published_at`, `created_at`, `deleted_at` |
| `content_hashtags`           | Exactly 3 per entry              | `content_entry_id`, `hashtag_id`, `position`, PK both                                                                                                                                                                                                                                     |
| `credit_ledger`              | **Credits** (spendable)          | `user_id`, `delta int`, `kind credit_kind`, `status ledger_status`, `entry_id`, `feedback_id`, `available_at timestamptz`, `created_by`, `note`, `reverses_id`                                                                                                                            |
| `credit_eligibility_reviews` | Review-window audit              | `feedback_id`, `user_id`, `decision`, `reason`, `reviewed_by`, `reviewed_at`                                                                                                                                                                                                              |
| `weekly_allowance_runs`      | Idempotency for weekly grants    | `period_start date unique`, `granted_count`, `ran_at`                                                                                                                                                                                                                                     |
| `feedback`                   | Optional critique                | `entry_id`, `author_id`, `body`, `tags feedback_tag[]`, `image_paths text[]`, `eligibility eligibility_state`, `eligibility_reason`, `opened_entry bool`, `hold_until`, `removed_at`, `edited_at`                                                                                         |
| `feedback_ratings`           | 1–10, rated once                 | `feedback_id unique`, `entry_owner_id`, `rater_id`, `score smallint check 1..10`, `source`, `created_at`, `revised_at`                                                                                                                                                                    |
| `reputation_ledger`          | **Reputation** (never spendable) | `user_id`, `delta int`, `kind reputation_kind`, `rating_id`, `feedback_id`, `created_at`, `reverses_id`                                                                                                                                                                                   |
| `outbound_clicks`            | Open events                      | `entry_id`, `user_id`, `clicked_at`, `client`, `source`, `return_token`                                                                                                                                                                                                                   |
| `feed_impressions`           | Rank audit + open state          | `entry_id`, `viewer_id`, `position`, `score numeric`, `reason_code`, `served_at`, `opened bool`, `opened_at`                                                                                                                                                                              |
| `feed_signals`               | Tuning signals                   | `viewer_id`, `entry_id`, `signal ('more_like','less_like','hide')`, `created_at`                                                                                                                                                                                                          |
| `mutes`                      | Muted creators                   | `viewer_id`, `muted_profile_id`, `created_at`                                                                                                                                                                                                                                             |
| `duration_events`            | Opt-in coarse bands              | `user_id`, `entry_id`, `band duration_band`, `returned boolean`, `consent_version`, `received_at`                                                                                                                                                                                         |
| `moderation_reports`         | User reports                     | `reporter_id`, `target_type report_target`, `target_id`, `reason`, `details`, `state report_state`, `resolved_by`, `resolution_note`                                                                                                                                                      |
| `moderation_actions`         | Immutable audit trail            | `actor_id`, `action`, `target_type`, `target_id`, `meta jsonb`, `created_at`                                                                                                                                                                                                              |

### 5.3 Hard constraints (the brief's rules, as DDL)

```sql
-- 1. Profile hashtags: 5 is a HARD maximum
create or replace function enforce_profile_hashtag_limit()
returns trigger language plpgsql as $$
declare cnt int;
begin
  select count(*) into cnt from profile_hashtags where profile_id = new.profile_id;
  if cnt > 5 then
    raise exception 'Profile hashtag limit exceeded: % > 5', cnt
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create constraint trigger profile_hashtag_limit_trg
  after insert or update on profile_hashtags
  deferrable initially deferred
  for each row execute function enforce_profile_hashtag_limit();

-- 2. Content entries: EXACTLY three hashtags
create or replace function enforce_entry_hashtag_count()
returns trigger language plpgsql as $$
declare cnt int;
begin
  select count(*) into cnt from content_hashtags
   where content_entry_id = new.content_entry_id;
  if cnt != 3 then
    raise exception 'Content entry must have exactly 3 hashtags, found %', cnt
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create constraint trigger entry_hashtag_count_trg
  after insert or update on content_hashtags
  deferrable initially deferred
  for each row execute function enforce_entry_hashtag_count();

-- 3. Feedback bounds
alter table feedback add constraint feedback_body_len
  check (char_length(body) between 10 and 4000);
alter table feedback add constraint feedback_max_images
  check (coalesce(array_length(image_paths, 1), 0) <= 3);

-- 4. Ratings are 1..10 and each feedback item is rated exactly once
alter table feedback_ratings add constraint rating_range check (score between 1 and 10);
create unique index feedback_ratings_one_per_feedback on feedback_ratings(feedback_id);

-- 5. Self-referential edge cases
alter table friendships add constraint friendship_no_self check (requester_id <> addressee_id);
alter table profile_hashtags add constraint profile_hashtag_pk primary key (profile_id, hashtag_id);
alter table content_hashtags  add constraint entry_hashtag_pk     primary key (content_entry_id, hashtag_id);
```

Self-feedback cannot be expressed as a `CHECK` (Postgres forbids subqueries in `CHECK`), so it lives in `enforce_feedback_integrity()`:

```sql
create or replace function enforce_feedback_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from content_entries e
              where e.id = new.entry_id and e.author_id = new.author_id) then
    raise exception 'You cannot leave feedback on your own content'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create constraint trigger feedback_no_self_trg
  before insert or update on feedback
  for each row execute function enforce_feedback_integrity();
```

**Deliberate design note on credits vs reputation.** `credit_ledger.delta` is a signed `int`; rows are never updated except for `status` transitions (`held` → `available` → `spent`/`reversed`). `reputation_ledger` has **no `status` column and no `spent` state at all** — it is strictly append-only with reversing pairs. There is no code path, SQL or TypeScript, that lets a reputation value authorize a submission. That is the structural guarantee behind "Reputation cannot be spent to publish content."

### 5.4 RLS policy matrix

| Table                        | anon                     | authenticated member                                           | admin          |
| ---------------------------- | ------------------------ | -------------------------------------------------------------- | -------------- |
| `profiles`                   | none (private community) | read all                                                       | read/write all |
| `invites`                    | none                     | read own                                                       | all            |
| `hashtags`                   | none                     | read all                                                       | write all      |
| `profile_hashtags`           | none                     | read all; write **own**                                        | all            |
| `profile_links`              | none                     | read all; write own                                            | all            |
| `friendships`                | none                     | rows where requester or addressee = `auth.uid()`               | all            |
| `content_entries`            | none                     | read `status = 'active'`; write own                            | all            |
| `content_hashtags`           | none                     | read all; write own entry                                      | all            |
| **`credit_ledger`**          | none                     | **read own only**; no direct insert                            | all            |
| `credit_eligibility_reviews` | none                     | read own                                                       | all            |
| `feedback`                   | none                     | read on visible entries; insert own; update own while editable | all            |
| `feedback_ratings`           | none                     | insert where `entry_owner_id = auth.uid()`                     | all            |
| `reputation_ledger`          | none                     | read all (public)                                              | all            |
| `outbound_clicks`            | none                     | insert/read own                                                | all            |
| `feed_impressions`           | none                     | insert/read own                                                | all            |
| `feed_signals`               | none                     | insert/delete own                                              | all            |
| `mutes`                      | none                     | own                                                            | all            |
| `duration_events`            | none                     | **own only, private**                                          | all            |
| `moderation_reports`         | none                     | insert own; read own                                           | all            |
| `moderation_actions`         | none                     | none                                                           | read all       |

Enable with `alter table <t> enable row level security;` plus `force row level security` on `credit_ledger` and `duration_events`. Default-deny comes from having **zero policies** for a role, not from writing `using (false)` everywhere.

**Credit privacy:** `credit_ledger` has no policy letting a member read another member's rows, so balances stay private per the brief. `get_credit_balance(p_user_id)` is `SECURITY DEFINER` and raises unless `p_user_id = auth.uid()` or the caller is an admin.

### 5.5 Core RPCs

| Function                                                           | Signature (abridged)                                                                                                                                | Rules enforced                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensure_profile`                                                   | `() -> profiles`                                                                                                                                    | Idempotent profile provisioning on first sign-in                                                                                                   |
| `get_credit_balance`                                               | `(p_user_id uuid) -> int`                                                                                                                           | Self-or-admin only                                                                                                                                 |
| `get_reputation`                                                   | `(p_user_id uuid) -> jsonb`                                                                                                                         | Public: total, rated count, avg, badge tier                                                                                                        |
| `create_content_entry`                                             | `(p_platform, p_url, p_canonical_url, p_title, p_caption, p_creator_note, p_asks_for_feedback, p_hashtags uuid[], p_cover_path) -> content_entries` | **Spends 1 credit atomically**; blocks if balance < cost; exactly-3 hashtags; blocked-account check; new-member rate cap; duplicate URL per author |
| `record_outbound_click`                                            | `(p_entry_id, p_client, p_source) -> uuid`                                                                                                          | Inserts `outbound_clicks`, returns a signed `return_token`                                                                                         |
| `mark_entry_opened`                                                | `(p_entry_id) -> void`                                                                                                                              | Upsert into `feed_impressions`; idempotent per viewer                                                                                              |
| `submit_feedback`                                                  | `(p_entry_id, p_body, p_tags feedback_tag[], p_image_paths text[]) -> feedback`                                                                     | Requires prior open; rejects self/blocked; sets `eligibility = 'pending'`                                                                          |
| `evaluate_feedback_eligibility`                                    | `(p_feedback_id) -> eligibility_state`                                                                                                              | Min length **or** an image; one feedback per entry per author; sets `held` with `hold_until`                                                       |
| `release_held_credits`                                             | `() -> int`                                                                                                                                         | Sweeper: `held` → `available` past `available_at`; scheduled in T10                                                                                |
| `rate_feedback`                                                    | `(p_feedback_id, p_score) -> feedback_ratings`                                                                                                      | Entry **owner only**; not own feedback; inserts rating + reputation ledger; refreshes aggregates                                                   |
| `revise_rating`                                                    | `(p_feedback_id, p_score) -> feedback_ratings`                                                                                                      | Within `RATING_REVISION_WINDOW_HOURS`; writes a reversing pair                                                                                     |
| `grant_weekly_allowance`                                           | `() -> int`                                                                                                                                         | Idempotent per `period_start`                                                                                                                      |
| `rank_feed`                                                        | `(p_limit int, p_cursor timestamptz, p_platforms platform_kind[]) -> table(rank, entry jsonb, score numeric, reason_code text)`                     | **Deterministic ranking** (fully implemented in T07)                                                                                               |
| `submit_feed_signal`                                               | `(p_entry_id, p_signal text)`                                                                                                                       | Records more/less/hide; idempotent upsert                                                                                                          |
| `mute_creator` / `unmute_creator`                                  | `(p_profile_id uuid)`                                                                                                                               | Upsert / delete                                                                                                                                    |
| `record_duration_event`                                            | `(p_entry_id, p_band, p_returned, p_consent_version)`                                                                                               | Rejects if consent version is stale                                                                                                                |
| `admin_grant_credit` / `admin_reverse_credit` / `admin_cap_credit` | `(p_user_id, p_amount, p_note)`                                                                                                                     | Admin-only; always writes `moderation_actions`                                                                                                     |
| `admin_resolve_report`                                             | `(p_report_id, p_state, p_note)`                                                                                                                    | Admin-only; cascades to hide/remove + ledger reversals                                                                                             |
| `admin_set_role`                                                   | `(p_user_id, p_role)`                                                                                                                               | Admin-only; guards against removing the last admin                                                                                                 |

### 5.6 `create_content_entry` — the atomic spend (most important function)

```sql
create or replace function create_content_entry(
  p_platform          platform_kind,
  p_url               text,
  p_canonical_url     text,
  p_title             text default null,
  p_caption           text default null,
  p_creator_note      text default null,
  p_asks_for_feedback boolean default false,
  p_hashtags          uuid[],
  p_cover_path        text default null
) returns content_entries
language plpgsql security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_cost    int  := current_setting('app.credit_submission_cost', true)::int;
  v_grace   int  := current_setting('app.new_member_grace_days', true)::int;
  v_ncap    int  := current_setting('app.new_member_submission_cap', true)::int;
  v_balance int;
  v_hash    bytea := digest(lower(p_canonical_url), 'sha256');
  v_entry   content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Exactly three DISTINCT hashtags
  if coalesce(array_length(p_hashtags, 1), 0) <> 3
     or (select count(distinct h) from unnest(p_hashtags) h) <> 3 then
    raise exception 'Exactly three distinct hashtags are required'
      using errcode = 'check_violation';
  end if;

  -- New-member submission rate cap (abuse control)
  if now() < (select created_at + make_interval(days => v_grace) from profiles where id = v_uid)
     and (select count(*) from content_entries
           where author_id = v_uid and created_at > now() - interval '24 hours') >= v_ncap then
    raise exception 'Submission rate limit reached for new members'
      using errcode = 'check_violation';
  end if;

  -- Duplicate URL guard per author
  if exists (select 1 from content_entries where author_id = v_uid and url_hash = v_hash) then
    raise exception 'You have already submitted this URL' using errcode = 'unique_violation';
  end if;

  -- ATOMIC SPEND. The advisory lock prevents double-spend under concurrency.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select coalesce(sum(delta), 0) into v_balance
    from credit_ledger
   where user_id = v_uid and status in ('available', 'held');

  if v_balance < v_cost then
    raise exception 'Insufficient Credits: need %, have %', v_cost, v_balance
      using errcode = 'check_violation';
  end if;

  insert into credit_ledger (user_id, delta, kind, status, note)
  values (v_uid, -v_cost, 'submission_spend', 'spent', 'Content submission');

  insert into content_entries (
    author_id, platform, original_url, canonical_url, url_hash,
    title, caption_excerpt, thumbnail_path, creator_note,
    asks_for_feedback, status, published_at
  ) values (
    v_uid, p_platform, p_url, p_canonical_url, v_hash,
    left(coalesce(p_title,''), 300), left(coalesce(p_caption,''), 1000),
    p_cover_path, left(coalesce(p_creator_note,''), 1000),
    p_asks_for_feedback, 'active', now()
  ) returning * into v_entry;

  insert into content_hashtags (content_entry_id, hashtag_id, position)
  select v_entry.id, h, ord - 1 from unnest(p_hashtags) with ordinality as t(h, ord);

  return v_entry;
end $$;
```

> `pg_advisory_xact_lock` is what makes concurrent submissions safe. Two rapid clicks create two overlapping transactions; without the lock both could read the same balance and both succeed, spending a credit that does not exist. This is a correctness requirement, not a nicety.

Tunable values (`app.credit_submission_cost`, `app.new_member_submission_cap`, …) are injected at connection time from `@fydio/env`, so operators tune policy via Coolify env vars without a migration.

### 5.7 `submit_feedback` — the only legitimate path to earning a Credit

```sql
create or replace function submit_feedback(
  p_entry_id    uuid,
  p_body        text,
  p_tags        feedback_tag[] default '{}',
  p_image_paths text[] default '{}'
) returns feedback
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry content_entries;
  v_min   int  := current_setting('app.feedback_min_chars', true)::int;
  v_fb    feedback;
begin
  select * into v_entry from content_entries where id = p_entry_id and status = 'active';
  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;
  if v_entry.author_id = v_uid then
    raise exception 'You cannot leave feedback on your own content'
      using errcode = 'check_violation';
  end if;

  -- "Connected to an entry they opened." This is an OPEN-HISTORY signal only.
  -- No credit is ever tied to time spent, so no duration is consulted here.
  if not exists (select 1 from feed_impressions
                  where entry_id = p_entry_id and viewer_id = v_uid and opened) then
    raise exception 'Open the content before leaving feedback'
      using errcode = 'check_violation';
  end if;

  -- One feedback per member per entry (anti-duplicate earning)
  if exists (select 1 from feedback where entry_id = p_entry_id and author_id = v_uid) then
    raise exception 'You already left feedback on this entry'
      using errcode = 'unique_violation';
  end if;

  -- Blocked-account check
  if exists (select 1 from friendships f
              where f.state = 'blocked'
                and (f.requester_id = v_entry.author_id and f.addressee_id = v_uid
                  or f.addressee_id  = v_entry.author_id and f.requester_id = v_uid)) then
    raise exception 'Blocked account' using errcode = 'insufficient_privilege';
  end if;

  -- Quality gate affects ELIGIBILITY, not submission. A short note is still
  -- allowed to exist; it simply earns nothing.
  insert into feedback (entry_id, author_id, body, tags, image_paths,
                        eligibility, eligibility_reason, opened_entry)
  values (
    p_entry_id, v_uid, p_body, p_tags, p_image_paths,
    case when char_length(p_body) >= v_min
           or coalesce(array_length(p_image_paths, 1), 0) > 0
         then 'pending'::eligibility_state else 'ineligible'::eligibility_state end,
    case when char_length(p_body) >= v_min
           or coalesce(array_length(p_image_paths, 1), 0) > 0
         then null else 'below_quality_threshold' end,
    true
  ) returning * into v_fb;

  return v_fb;
end $$;
```

### 5.8 `evaluate_feedback_eligibility` — where a Credit is actually earned

```sql
create or replace function evaluate_feedback_eligibility(p_feedback_id uuid)
returns eligibility_state
language plpgsql security definer set search_path = public
as $$
declare
  v_fb     feedback;
  v_day    int := current_setting('app.credit_per_day_cap', true)::int;
  v_crea   int := current_setting('app.credit_per_creator_cap', true)::int;
  v_hold   int := current_setting('app.credit_hold_hours', true)::int;
  v_amt    int := current_setting('app.feedback_credit_amount', true)::int;
  v_seen   int;
  v_by_own int;
begin
  select * into v_fb from feedback where id = p_feedback_id for update;
  if v_fb.eligibility <> 'pending' then
    return v_fb.eligibility;   -- idempotent
  end if;

  -- Reported or removed => never eligible, and any prior credit is reversed
  if v_fb.removed_at is not null
     or exists (select 1 from moderation_reports
                 where target_type = 'feedback' and target_id = v_fb.id
                   and state <> 'dismissed') then
    update feedback set eligibility = 'reversed' where id = v_fb.id;
    return 'reversed';
  end if;

  select count(*) into v_seen from credit_ledger
   where user_id = v_fb.author_id and kind = 'feedback_earned'
     and status in ('held','available')
     and created_at > now() - interval '24 hours';
  if v_seen >= v_day then
    update feedback set eligibility = 'ineligible',
           eligibility_reason = 'daily_cap_reached' where id = v_fb.id;
    return 'ineligible';
  end if;

  select count(*) into v_by_own from credit_ledger
   where user_id = v_fb.author_id and kind = 'feedback_earned'
     and status in ('held','available') and entry_id = v_fb.entry_id;
  if v_by_own >= v_crea then
    update feedback set eligibility = 'ineligible',
           eligibility_reason = 'per_creator_cap_reached' where id = v_fb.id;
    return 'ineligible';
  end if;

  -- ELIGIBLE -> held credit with a review window
  insert into credit_ledger
    (user_id, delta, kind, status, entry_id, feedback_id, available_at, note)
  values
    (v_fb.author_id, v_amt, 'feedback_earned', 'held',
     v_fb.entry_id, v_fb.id, now() + make_interval(hours => v_hold),
     'Eligible peer feedback (pending review window)');

  update feedback set eligibility = 'eligible',
         hold_until = now() + make_interval(hours => v_hold)
   where id = v_fb.id;
  return 'eligible';
end $$;
```

The MVP value of `app.feedback_credit_amount` is **1**. Reputation ratings do **not** feed into it — enforced by the complete absence of any rating reference in this function.

### 5.9 `rate_feedback` — reputation only, never spendable

```sql
create or replace function rate_feedback(p_feedback_id uuid, p_score smallint)
returns feedback_ratings
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_fb     feedback;
  v_owner  uuid;
  v_rating feedback_ratings;
begin
  if p_score < 1 or p_score > 10 then
    raise exception 'Rating must be between 1 and 10' using errcode = 'check_violation';
  end if;

  select f.*, e.author_id into v_fb, v_owner
    from feedback f
    join content_entries e on e.id = f.entry_id
   where f.id = p_feedback_id;

  if v_owner <> v_uid then
    raise exception 'Only the content owner can rate feedback on their own entry'
      using errcode = 'insufficient_privilege';
  end if;
  if v_fb.author_id = v_uid then
    raise exception 'Self-rating is not allowed' using errcode = 'check_violation';
  end if;
  if exists (select 1 from feedback_ratings where feedback_id = p_feedback_id) then
    raise exception 'This feedback has already been rated' using errcode = 'unique_violation';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_fb.author_id::text));

  insert into feedback_ratings (feedback_id, entry_owner_id, rater_id, score, source)
  values (p_feedback_id, v_uid, v_uid, p_score, 'creator_rating')
  returning * into v_rating;

  -- Reputation ledger. NO REFERENCE TO credit_ledger ANYWHERE IN THIS PATH.
  insert into reputation_ledger (user_id, delta, kind, rating_id, feedback_id)
  values (v_fb.author_id, p_score, 'creator_rating', v_rating.id, p_feedback_id);

  perform refresh_profile_reputation(v_fb.author_id);
  return v_rating;
end $$;
```

### 5.10 Indexes

```sql
-- Feed
create index content_entries_active_published_idx
  on content_entries (published_at desc) where status = 'active';
create index content_hashtags_hashtag_idx on content_hashtags (hashtag_id);
create index profile_hashtags_hashtag_idx  on profile_hashtags  (hashtag_id);

-- Credit ledger hot paths
create index credit_ledger_user_status_idx on credit_ledger (user_id, status);
create index credit_ledger_user_kind_time_idx on credit_ledger (user_id, kind, created_at desc);
create index credit_ledger_feedback_idx on credit_ledger (feedback_id) where feedback_id is not null;
create index credit_ledger_hold_due_idx on credit_ledger (available_at)
  where status = 'held';                    -- partial index for the sweeper

-- Feedback inbox
create index feedback_entry_idx   on feedback (entry_id, created_at desc);
create index feedback_author_idx  on feedback (author_id, created_at desc);
create index feedback_pending_idx on feedback (eligibility) where eligibility = 'pending';

-- Open history + feed metrics
create index outbound_clicks_entry_user_idx on outbound_clicks (entry_id, user_id, clicked_at desc);
create unique index feed_impressions_viewer_entry_idx on feed_impressions (viewer_id, entry_id);
create index feed_impressions_entry_time_idx on feed_impressions (entry_id, served_at desc);

-- Reputation
create index reputation_ledger_user_idx on reputation_ledger (user_id, created_at desc);
create index feedback_ratings_feedback_idx on feedback_ratings (feedback_id);
```

### 5.11 Seed data (`supabase/seed.sql`)

- 1 admin + 29 members (`@demo.test` emails, local-only password) with handles `member_01..member_29`
- ~40 hashtags across editing, hooks, thumbnails, storytelling, audio, color, gear, growth
- Every member gets 5 profile hashtags; every entry gets exactly 3
- A friendship graph with realistic density (~35% accepted, some pending)
- ~180 `content_entries` spread over the last 30 days with mixed `preview_state`
- ~120 `feedback` items; ~60 rated 4–10; mix of `eligible` / `ineligible` / `held`
- `credit_ledger` rows consistent with those feedback items, including weekly allowances
- 2 open `moderation_reports`
- Deterministic — `setseed` + no bare `random()`, so the dev environment is reproducible

Seed data must respect every invariant. If it does not, the triggers are wrong.

---

## 6. Files to create

| Path                                                        | Purpose                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `supabase/migrations/0001_enums_and_extensions.sql`         | `pgcrypto`, `citext`, all enums                                     |
| `supabase/migrations/0002_invites_profiles_hashtags.sql`    | Identity + tag vocabulary + 5-hashtag trigger + `handle_new_user()` |
| `supabase/migrations/0003_friendships.sql`                  | Mutual connections, normalized `pair_key`                           |
| `supabase/migrations/0004_credit_ledger.sql`                | Credits ledger, balance + allowance + sweeper functions             |
| `supabase/migrations/0005_content_entries.sql`              | Entries, exactly-3 trigger, `create_content_entry()`                |
| `supabase/migrations/0006_feedback_and_ratings.sql`         | Feedback, eligibility, ratings, reputation ledger                   |
| `supabase/migrations/0007_feed_signals_and_impressions.sql` | Ranking inputs + tuning signals                                     |
| `supabase/migrations/0008_telemetry_and_reports.sql`        | Clicks, duration, moderation tables                                 |
| `supabase/migrations/0009_rls_policies.sql`                 | Every policy from §5.4                                              |
| `supabase/migrations/0010_admin_functions.sql`              | Admin-only operations                                               |
| `supabase/migrations/0011_indexes_and_views.sql`            | Indexes + reporting views                                           |
| `supabase/seed.sql`                                         | Deterministic fixtures                                              |
| `supabase/tests/001_invariants.sql`                         | pgTAP: hashtag limits, exact-3, no self-feedback                    |
| `supabase/tests/002_credits.sql`                            | pgTAP: spend, caps, hold, reversals, concurrency                    |
| `supabase/tests/003_reputation.sql`                         | pgTAP: rating-once, owner-only, non-spendability                    |
| `supabase/tests/004_rls.sql`                                | pgTAP: credit privacy, cross-user denial                            |
| `packages/supabase/src/types.generated.ts`                  | Generated `Database` type                                           |
| `packages/supabase/src/types.ts`                            | Re-export + row aliases                                             |

---

## 7. Implementation steps

- [ ] Enable `pgcrypto` (`digest`) and `citext`
- [ ] `0001`: all enum types (separate `credit_kind` and `reputation_kind`)
- [ ] `0002`: `invites`, `profiles`, `hashtags`, `profile_hashtags`, `profile_links`; 5-hashtag limit trigger; `handle_new_user()` trigger on `auth.users`
- [ ] `0003`: `friendships` with normalized `pair_key` generated column + unique index
- [ ] `0004`: `credit_ledger`, `credit_eligibility_reviews`, `weekly_allowance_runs`, `get_credit_balance()`, `grant_weekly_allowance()`, `release_held_credits()`
- [ ] `0005`: `content_entries`, `content_hashtags`, exactly-3 trigger, `create_content_entry()` with the advisory lock
- [ ] `0006`: `feedback`, `feedback_ratings`, `reputation_ledger`, `submit_feedback()`, `evaluate_feedback_eligibility()`, `rate_feedback()`, `revise_rating()`, `refresh_profile_reputation()`
- [ ] `0007`: `feed_impressions`, `feed_signals`, `mutes`, `mark_entry_opened()`, `submit_feed_signal()`, `mute_creator()`/`unmute_creator()`, `rank_feed()` stub
- [ ] `0008`: `outbound_clicks`, `duration_events`, `moderation_reports`, `moderation_actions`, `record_outbound_click()`, `record_duration_event()`
- [ ] `0009`: enable + force RLS on every table; author every policy from §5.4
- [ ] `0010`: `admin_grant_credit`, `admin_reverse_credit`, `admin_cap_credit`, `admin_resolve_report`, `admin_set_role` — each writing `moderation_actions`
- [ ] `0011`: indexes + views (`profile_reputation`, `entry_feedback_summary`, `weekly_engagement_dashboard`)
- [ ] Write pgTAP suites; run `supabase test db` until green
- [ ] Write `supabase/seed.sql`; run `pnpm db:reset` and confirm zero constraint violations
- [ ] Generate types into `packages/supabase/src/types.generated.ts`; wire `src/types.ts`
- [ ] Write `packages/domain/src/db-types.ts` — narrow aliases (`Profile`, `ContentEntry`, `CreditBalance`, …)
- [ ] Add `packages/supabase` integration tests using the service client against seeded data
- [ ] Stub `docs/architecture/data-model.md` (expanded in T10)

---

## 8. Acceptance criteria

- [ ] `pnpm db:reset` completes with **zero** constraint violations on seed
- [ ] `supabase test db` passes all four suites
- [ ] A 6th profile hashtag raises `check_violation`
- [ ] An entry with 2, 4, or 5 hashtags raises `check_violation`; exactly 3 succeeds
- [ ] Submitting with 0 available Credits raises `Insufficient Credits`
- [ ] Two **concurrent** `create_content_entry` calls with a balance of exactly 1 succeed exactly once
- [ ] Per-day and per-creator credit caps enforced, returning `ineligible` with a reason
- [ ] Held credits are excluded from spend until `release_held_credits()` runs
- [ ] A member cannot read another member's `credit_ledger` rows
- [ ] Only the entry owner can rate; a second rating raises `unique_violation`
- [ ] Self-feedback is rejected at both `submit_feedback()` and the trigger level
- [ ] Reputation total changes by exactly the rating score and by **zero** credits
- [ ] `grant_weekly_allowance()` is idempotent across repeated calls in one period
- [ ] No function reads `reputation_ledger` inside any credit-awarding path (asserted by a grep test)

---

## 9. Tests

**pgTAP (in-database, `supabase test db`):**

- **Constraint**: hashtag limits, exact-3, feedback image cap, rating range, no-self-friendship, duplicate tag rejection
- **Credits**: atomic spend, double-spend under concurrency, cap enforcement, hold → available, `admin_reverse_credit` reversal pair, weekly-allowance idempotency
- **Reputation**: owner-only rating, rate-once, revision window, moderation reversal, aggregate accuracy
- **RLS**: cross-user `select` returns 0 rows on `credit_ledger` and `duration_events`; insert attempts fail; service role bypasses as expected
- **Negative non-spendability**: grant a member 500 reputation with 0 credits; `create_content_entry` must still fail. _This is the single most important test in the task._

**Integration (Vitest + service client):** round-trip each RPC against seeded data; assert error `code` and message shape.

---

## 10. Verification commands

```bash
pnpm dev:stack
pnpm db:reset
pnpm --filter @fydio/web db:types
supabase test db

psql "$DATABASE_URL" -c "\dt public.*"
psql "$DATABASE_URL" -c "select proname from pg_proc where pronamespace='public'::regnamespace order by 1;"
psql "$DATABASE_URL" -c "select tablename, rowsecurity from pg_tables where schemaname='public';"
psql "$DATABASE_URL" -c "select relname, relforcerowsecurity from pg_class where relname in ('credit_ledger','duration_events');"

# Credit privacy proof
psql "$DATABASE_URL" -c "set role authenticated; set request.jwt.claim.sub='<other-uuid>'; select count(*) from credit_ledger;"
```

---

## 11. Risks & mitigations

| Risk                                                                                        | Mitigation                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deferrable constraint triggers surprise developers ("insert succeeded, commit failed")      | Document clearly; validate hashtag count in the Zod layer first so users never see the raw error     |
| `pg_advisory_xact_lock` serializes a user's submissions and could contend at scale          | Lock is per-`user_id`; irrelevant at 30 members. Note sharding as a post-MVP concern                 |
| Credit balance shown stale in the UI between reads                                          | Expose `get_credit_balance()` as one RPC and re-read after every mutation; no client-side arithmetic |
| RLS recursion (policy on `feedback` joins `content_entries`, whose policy joins `profiles`) | Wrap checks in `SECURITY DEFINER` helper functions marked `stable` with `set search_path = public`   |
| Ledger rows updated in place break auditability                                             | Credits only transition `status`; reputation is append-only with reversing pairs                     |
| Someone later adds a reputation → credit conversion                                         | CI grep test: no `reputation_ledger` read inside any credit-insert path                              |
| 30 seeds × 180 entries makes `db:reset` slow                                                | Deterministic `generate_series` batch inserts; target < 15 s                                         |

---

## 12. Definition of done

Every invariant from brief §2, §8, and §9 is enforced by Postgres — not by the UI. The pgTAP suite fails if any is violated, and generated types are committed so TypeScript always reflects the live schema.
