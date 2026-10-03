-- =============================================================================
-- T02 · 0001 — Extensions and enums
-- =============================================================================
--
-- The foundation: extensions, the tunable-settings reader, and the type
-- vocabulary every later migration builds on. No tables yet.
--
-- WHY `extensions` AND NOT `public`
-- `citext` joins `pgcrypto` in the `extensions` schema, which is the Supabase
-- convention and where this stack's image already put pgcrypto. That has one
-- consequence worth stating now rather than debugging later: every
-- SECURITY DEFINER function below pins `search_path = public`, so it cannot
-- resolve `citext` or `digest` unqualified. They qualify explicitly —
-- `extensions.digest` — rather than widening `search_path`. Widening it would
-- reopen the search_path-injection hole that pinning exists to close, and
-- `citext` appears in DDL (resolved with the session path, which includes
-- `extensions`) rather than inside function bodies, so nothing else needs it.
--
-- WHY `credit_kind` AND `reputation_kind` ARE SEPARATE TYPES
-- The product brief forbids treating Credits and Reputation as one currency.
-- Two enum types make that structural rather than conventional: there is no
-- single `kind` column that could accept both, so no code path — SQL or
-- TypeScript — can accidentally write a `feedback_earned` credit into a
-- reputation insert, or read a rating as if it were spendable. Credits are
-- earnable and spendable; Reputation is a quality signal that is never
-- spendable. Two enums, two ledgers, no shared vocabulary.

-- Tunables arrive as `app.*` session GUCs, injected by the application at
-- connection time so an operator can change policy through an environment
-- variable (Coolify, `.env`) rather than by editing a migration. Nothing sets
-- them today, so every read has to tolerate absence: `current_setting(name,
-- true)` returns NULL for an unset GUC, and `NULL::int` is NULL, which would
-- silently turn every cap comparison into NULL — and `NULL >= 5` is NULL, so the
-- cap check would quietly pass. `coalesce` against the documented default makes
-- a missing GUC mean "use the MVP default" instead of "disable the safeguard".
--
-- The defaults here mirror `packages/env`'s schema. If one side changes, change
-- both: a divergent default is a policy value nobody can find.

create or replace function public.app_setting_int(p_name text, p_default integer)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(nullif(current_setting(p_name, true), '')::integer, p_default);
$$;

-- `ALTER DATABASE ... SET` installs these defaults so a fresh database — one
-- where the application has not yet connected to set them — behaves with sane
-- policy instead of no policy. A connection-level `set` from the app still wins.
do $$
declare
  defaults text[][] := array[
    array['app.credit_submission_cost', '1'],
    array['app.credit_weekly_starter_allowance', '3'],
    array['app.credit_per_day_cap', '5'],
    array['app.credit_per_creator_cap', '2'],
    array['app.credit_hold_hours', '48'],
    array['app.feedback_credit_amount', '1'],
    array['app.new_member_submission_cap', '3'],
    array['app.new_member_grace_days', '14'],
    array['app.feedback_min_chars', '40'],
    array['app.rating_revision_window_hours', '24']
  ];
  item text[];
begin
  foreach item slice 1 in array defaults loop
    -- `set_config(..., false)` makes it a session default for every future
    -- connection to this database. Harm if already set: a connection-level value
    -- from the application takes precedence.
    perform set_config(item[1], item[2], false);
  end loop;
end;
$$;

create extension if not exists citext with schema extensions;

-- --- Content and identity ----------------------------------------------------

create type platform_kind as enum (
  'instagram',
  'tiktok',
  'youtube',
  'x'
);

create type profile_role as enum (
  'member',
  'admin'
);

create type friendship_state as enum (
  'pending',
  'accepted',
  'declined',
  'blocked'
);

create type entry_state as enum (
  'active',
  'hidden',
  'removed'
);

create type preview_state as enum (
  'pending',
  'resolved',
  'unavailable',
  'failed'
);

-- --- Credits: earnable and SPENDABLE -----------------------------------------
--
-- Every value here either adds to or subtracts from a spendable balance.
-- `hold_release` and `hold_reversal` name transitions rather than movements:
-- releasing a held credit flips the original row's status instead of inserting
-- a second row, so the enum documents the whole lifecycle even though not
-- every value appears in an INSERT.

create type credit_kind as enum (
  'weekly_allowance',
  'feedback_earned',
  'submission_spend',
  'admin_grant',
  'admin_reverse',
  'hold_release',
  'hold_reversal',
  'entry_removed_reversal'
);

-- --- Reputation: NOT spendable ------------------------------------------------
--
-- Note what is absent: there is no `spend` value, no `held`, no `available`.
-- Reputation is append-only, so there is nothing here that could be exchanged
-- for a submission even by accident.

create type reputation_kind as enum (
  'creator_rating',
  'rating_revision',
  'moderation_reversal'
);

-- --- Ledger accounting --------------------------------------------------------
--
-- `status` defines what a row contributes to a spendable balance:
--
--   held       -> contributes nothing; pending its review window
--   available  -> contributes `delta` (positive, spendable)
--   spent      -> contributes `delta` (negative; this is what a submission
--                 actually subtracts — see 0004 for why it must be counted)
--   reversed   -> contributes nothing; the movement it described was undone
--
-- `held` and `available` are for grants. `spent` and `reversed` are for
-- outflows. Getting this backwards is how a ledger ends up that never
-- depletes, so 0004 pins the balance arithmetic in a comment and the pgTAP
-- suite in 002_credits.sql asserts it directly.

create type ledger_status as enum (
  'held',
  'available',
  'spent',
  'reversed'
);

-- --- Feedback and moderation --------------------------------------------------

create type eligibility_state as enum (
  'pending',
  'eligible',
  'ineligible',
  'held',
  'reversed',
  'removed'
);

create type feedback_tag as enum (
  'hook',
  'clarity',
  'editing',
  'storytelling',
  'thumbnail',
  'cta',
  'audience_fit'
);

create type report_state as enum (
  'open',
  'reviewing',
  'resolved',
  'dismissed'
);

create type report_target as enum (
  'user',
  'content_entry',
  'feedback',
  'hashtag'
);

-- --- Feed and telemetry -------------------------------------------------------

create type feed_signal_kind as enum (
  'more_like',
  'less_like',
  'hide'
);

-- Coarse bands only. The brief asks for "under 15 seconds, 15-60 seconds,
-- 1-3 minutes, over 3 minutes" and nothing finer — duration is never
-- attributed to a member, never ranked on, and never earns anything.
create type duration_band as enum (
  'lt_15s',
  's15_60',
  'm1_3',
  'gt_3',
  'unknown'
);

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop type if exists duration_band;
-- drop type if exists feed_signal_kind;
-- drop type if exists report_target;
-- drop type if exists report_state;
-- drop type if exists feedback_tag;
-- drop type if exists eligibility_state;
-- drop type if exists ledger_status;
-- drop type if exists reputation_kind;
-- drop type if exists credit_kind;
-- drop type if exists preview_state;
-- drop type if exists entry_state;
-- drop type if exists friendship_state;
-- drop type if exists profile_role;
-- drop type if exists platform_kind;
-- drop extension if exists citext;