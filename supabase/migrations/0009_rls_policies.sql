-- =============================================================================
-- T02 · 0009 — Row level security
-- =============================================================================
--
-- Every table gets RLS enabled AND an explicit policy. Default-deny comes from a
-- role having ZERO policies, not from writing `using (false)` on every table: a
-- policy that denies is one more thing to keep in sync, and it obscures which
-- tables are deliberately unreachable.
--
-- So the reading of this file is: "no policy below means no access", and the
-- table for that case is `moderation_actions`, which no member may ever read.
--
-- WHY `SECURITY DEFINER` POLICY HELPERS
-- A policy on `feedback` needs to know whether the entry is visible, which means
-- querying `content_entries`, whose own policy needs `profiles`. Postgres detects
-- that cycle and either errors or silently recurses. The helpers below break it:
-- they are SECURITY DEFINER, so they read the tables as their owner (who bypasses
-- RLS) and return a plain boolean, with the caller never re-entering the policy
-- system. They are `stable` so the planner calls them once per statement, not once
-- per row.

-- --- Enable RLS everywhere -------------------------------------------------------
--
-- Includes the tables no client ever queries directly. RLS that is enabled on some
-- tables and forgotten on others is worse than none: it reads as a deliberate
-- boundary and is not one.

alter table public.invites                    enable row level security;
alter table public.profiles                   enable row level security;
alter table public.hashtags                   enable row level security;
alter table public.profile_hashtags           enable row level security;
alter table public.profile_links              enable row level security;
alter table public.friendships                enable row level security;
alter table public.content_entries            enable row level security;
alter table public.content_hashtags           enable row level security;
alter table public.credit_ledger              enable row level security;
alter table public.credit_eligibility_reviews enable row level security;
alter table public.weekly_allowance_runs      enable row level security;
alter table public.feedback                   enable row level security;
alter table public.feedback_ratings           enable row level security;
alter table public.reputation_ledger          enable row level security;
alter table public.feed_impressions           enable row level security;
alter table public.feed_signals               enable row level security;
alter table public.mutes                      enable row level security;
alter table public.outbound_clicks            enable row level security;
alter table public.duration_events            enable row level security;
alter table public.moderation_reports         enable row level security;
alter table public.moderation_actions         enable row level security;

-- FORCE additionally applies RLS to the table OWNER. Two tables get it:
--
--   credit_ledger    a balance is private per the brief; FORCE means even the
--                    owner role cannot read it without going through
--                    get_credit_balance(), which checks self-or-admin.
--   duration_events  private telemetry. Same reasoning, and it is the table most
--                    likely to be joined into something by accident later.
--
-- Note the SECURITY DEFINER RPCs still work: they run as the owner, and the owner
-- here is `postgres`, which has BYPASSRLS. FORCE constrains the app roles, not the
-- functions that are supposed to be the way in.

alter table public.credit_ledger   force row level security;
alter table public.duration_events force row level security;

-- --- Policy helpers ---------------------------------------------------------------

-- Is an entry visible to a given viewer? Active entries are public within the
-- community; a member can always see their own even once it is hidden.
create or replace function public.can_view_entry(p_entry_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.content_entries e
     where e.id = p_entry_id
       and (e.status = 'active' or e.author_id = p_viewer)
  );
$$;

-- Can this viewer see the entry's tags? Follows the entry's visibility, so a tag
-- row for a hidden entry is not a way to discover that the entry exists.
create or replace function public.can_view_entry_hashtags(p_entry_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_view_entry(p_entry_id, p_viewer);
$$;

-- =============================================================================
-- Policies — members
-- =============================================================================

-- profiles: readable by every member (the community is private and
-- invite-only, so "public" means "visible to other members"). Reputation is
-- deliberately included — the brief says show reputation publicly, keep Credits
-- private — and the aggregates cannot be written by their owner anyway.

create policy profiles_read on public.profiles
  for select to authenticated
  using (true);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- invites: a member may see only their own.
create policy invites_read_own on public.invites
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

create policy invites_admin_all on public.invites
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- hashtags: shared vocabulary, readable by all, writable by admins.
create policy hashtags_read on public.hashtags
  for select to authenticated
  using (true);

create policy hashtags_admin_write on public.hashtags
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profile_hashtags_read on public.profile_hashtags
  for select to authenticated
  using (true);

create policy profile_hashtags_write_own on public.profile_hashtags
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy profile_hashtags_admin_all on public.profile_hashtags
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy profile_links_read on public.profile_links
  for select to authenticated
  using (true);

create policy profile_links_write_own on public.profile_links
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy profile_links_admin_all on public.profile_links
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- friendships: only the two people involved can see the row.
create policy friendships_read_involved on public.friendships
  for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy friendships_insert_own on public.friendships
  for insert to authenticated
  with check (requester_id = auth.uid());

-- Only the addressee answers a request, and only by moving it out of `pending`.
-- Letting the requester update the row would let them mark a request accepted
-- without the other person agreeing.
create policy friendships_update_addressee on public.friendships
  for update to authenticated
  using (addressee_id = auth.uid() and state = 'pending')
  with check (addressee_id = auth.uid());

create policy friendships_admin_all on public.friendships
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- content_entries: active entries readable; a member writes only their own.
create policy content_entries_read on public.content_entries
  for select to authenticated
  using (status = 'active' or author_id = auth.uid());

create policy content_entries_insert_own on public.content_entries
  for insert to authenticated
  with check (author_id = auth.uid());

create policy content_entries_update_own on public.content_entries
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy content_entries_admin_all on public.content_entries
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy content_hashtags_read on public.content_hashtags
  for select to authenticated
  using (public.can_view_entry_hashtags(content_entry_id, auth.uid()));

create policy content_hashtags_write_own on public.content_hashtags
  for all to authenticated
  using (exists (
    select 1 from public.content_entries e
     where e.id = content_entry_id and e.author_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.content_entries e
     where e.id = content_entry_id and e.author_id = auth.uid()
  ));

create policy content_hashtags_admin_all on public.content_hashtags
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- =============================================================================
-- CREDIT LEDGER — the privacy rule
-- =============================================================================
-- A member can read ONLY their own rows. There is deliberately no policy that
-- would let one member read another's balance, which is what makes Credit privacy
-- structural rather than a UI decision. `get_credit_balance` is the sanctioned way
-- to ask about a balance, and it re-checks self-or-admin inside the function
-- because SECURITY DEFINER bypasses this policy.

create policy credit_ledger_read_own on public.credit_ledger
  for select to authenticated
  using (user_id = auth.uid());

-- NO insert policy for members. Credits are only ever created by the SECURITY
-- DEFINER RPCs. A member cannot grant themselves a Credit by inserting a row, and
-- `admin_grant_credit` is the only admin path — which is itself a function, so
-- even an admin writes through an audited call rather than a raw insert.

create policy credit_ledger_admin_all on public.credit_ledger
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy credit_eligibility_reviews_read_own on public.credit_eligibility_reviews
  for select to authenticated
  using (user_id = auth.uid());

create policy credit_eligibility_reviews_admin_all on public.credit_eligibility_reviews
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy weekly_allowance_runs_admin_read on public.weekly_allowance_runs
  for select to authenticated
  using (public.is_admin());

-- feedback: readable where its entry is visible; writable only by its author.
create policy feedback_read on public.feedback
  for select to authenticated
  using (public.can_view_entry(entry_id, auth.uid()));

create policy feedback_insert_own on public.feedback
  for insert to authenticated
  with check (author_id = auth.uid());

-- Editable while unrated and inside the grace window, per brief §7 ("edit or
-- remove until it is rated or after a short grace period"). Once rated, the
-- reputation ledger already refers to it and the text must stay put.
create policy feedback_update_own on public.feedback
  for update to authenticated
  using (
    author_id = auth.uid()
    and removed_at is null
    and not exists (select 1 from public.feedback_ratings r where r.feedback_id = id)
  )
  with check (author_id = auth.uid());

create policy feedback_admin_all on public.feedback
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- feedback_ratings: readable by all (reputation is public), written only through
-- rate_feedback. There is no member INSERT policy: "only the entry owner may rate"
-- is a rule that needs the entry, the feedback and the rating count at once, and
-- expressing it as a policy would duplicate logic that belongs in the RPC.
create policy feedback_ratings_read on public.feedback_ratings
  for select to authenticated
  using (true);

create policy feedback_ratings_admin_all on public.feedback_ratings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- reputation_ledger: readable by all. This is the deliberate counterpart to the
-- credit ledger — reputation is public by product decision, credits are not.
create policy reputation_ledger_read on public.reputation_ledger
  for select to authenticated
  using (true);

-- Private per-member telemetry. Self-only, and FORCE RLS applies to the owner too.
create policy outbound_clicks_read_own on public.outbound_clicks
  for select to authenticated
  using (user_id = auth.uid());

create policy outbound_clicks_insert_own on public.outbound_clicks
  for insert to authenticated
  with check (user_id = auth.uid());

create policy outbound_clicks_admin_all on public.outbound_clicks
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy feed_impressions_read_own on public.feed_impressions
  for select to authenticated
  using (viewer_id = auth.uid());

-- Insertable by anyone for themselves, so the feed can record impressions it
-- served without a bespoke RPC for every write.
create policy feed_impressions_insert_own on public.feed_impressions
  for insert to authenticated
  with check (viewer_id = auth.uid());

create policy feed_impressions_admin_all on public.feed_impressions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy feed_signals_read_own on public.feed_signals
  for select to authenticated
  using (viewer_id = auth.uid());

create policy feed_signals_write_own on public.feed_signals
  for all to authenticated
  using (viewer_id = auth.uid())
  with check (viewer_id = auth.uid());

create policy feed_signals_admin_all on public.feed_signals
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy mutes_read_own on public.mutes
  for select to authenticated
  using (viewer_id = auth.uid());

create policy mutes_write_own on public.mutes
  for all to authenticated
  using (viewer_id = auth.uid())
  with check (viewer_id = auth.uid());

create policy mutes_admin_all on public.mutes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- duration_events: PRIVATE. Own rows only, and FORCE RLS above means the table
-- owner is bound too. No admin read policy is added on purpose: the brief says
-- duration data is private to the viewer and is used for their own history, so
-- there is deliberately no role — admin included — with a direct read path.
create policy duration_events_own on public.duration_events
  for select to authenticated
  using (user_id = auth.uid());

create policy duration_events_insert_own on public.duration_events
  for insert to authenticated
  with check (user_id = auth.uid());

-- moderation_reports: a member files and sees their own reports; admins see all.
create policy moderation_reports_read_own on public.moderation_reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

create policy moderation_reports_insert_own on public.moderation_reports
  for insert to authenticated
  with check (reporter_id = auth.uid());

create policy moderation_reports_admin_update on public.moderation_reports
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- moderation_actions: DELIBERATELY NO MEMBER POLICY.
--
-- This is the one table with zero policies for `authenticated`. Default-deny by
-- omission rather than `using (false)`, and the pgTAP suite asserts a member
-- reading it gets zero rows. Only admins can read the moderation audit trail.
create policy moderation_actions_admin_read on public.moderation_actions
  for select to authenticated
  using (public.is_admin());

-- =============================================================================
-- Function privileges
-- =============================================================================
--
-- Every SECURITY DEFINER function runs as its owner and bypasses RLS, so the
-- EXECUTE grant is the real access-control surface for them.
--
-- Revoking from PUBLIC is necessary but NOT sufficient. This stack's Supabase
-- image installs `alter default privileges in schema public grant all on
-- functions to postgres, anon, authenticated, service_role`, so every function
-- created by a migration is granted to `anon` at CREATE time. `revoke ... from
-- public` alone leaves that grant standing, and `anon` can still execute any RPC —
-- including the ones that spend Credits. `anon` is revoked explicitly below and
-- `004_rls.sql` asserts it cannot reach them.

revoke execute on function public.create_content_entry(platform_kind, text, text, uuid[], text, text, text, boolean, text) from public;
revoke execute on function public.get_credit_balance(uuid) from public;
revoke execute on function public.submit_feedback(uuid, text, feedback_tag[], text[]) from public;
revoke execute on function public.evaluate_feedback_eligibility(uuid) from public;
revoke execute on function public.rate_feedback(uuid, smallint) from public;
revoke execute on function public.revise_rating(uuid, smallint) from public;
revoke execute on function public.record_outbound_click(uuid, text, text) from public;
revoke execute on function public.record_duration_event(uuid, duration_band, text, boolean) from public;
revoke execute on function public.release_held_credits() from public;
revoke execute on function public.grant_weekly_allowance(integer) from public;
revoke execute on function public.mark_entry_opened(uuid) from public;
revoke execute on function public.mute_creator(uuid) from public;
revoke execute on function public.unmute_creator(uuid) from public;
revoke execute on function public.submit_feed_signal(uuid, text) from public;

-- Member-callable RPCs.
grant execute on function public.ensure_profile() to authenticated;
grant execute on function public.get_credit_balance(uuid) to authenticated;
grant execute on function public.get_reputation(uuid) to authenticated;
grant execute on function public.rank_feed(integer, timestamptz, platform_kind[]) to authenticated;
grant execute on function public.create_content_entry(platform_kind, text, text, uuid[], text, text, text, boolean, text) to authenticated;
grant execute on function public.submit_feedback(uuid, text, feedback_tag[], text[]) to authenticated;
grant execute on function public.rate_feedback(uuid, smallint) to authenticated;
grant execute on function public.revise_rating(uuid, smallint) to authenticated;
grant execute on function public.record_outbound_click(uuid, text, text) to authenticated;
grant execute on function public.record_duration_event(uuid, duration_band, text, boolean) to authenticated;
grant execute on function public.mark_entry_opened(uuid) to authenticated;
grant execute on function public.submit_feed_signal(uuid, text) to authenticated;
grant execute on function public.mute_creator(uuid) to authenticated;
grant execute on function public.unmute_creator(uuid) to authenticated;

-- Sweeper and eligibility evaluation are jobs, not member actions.
grant execute on function public.release_held_credits() to service_role;
grant execute on function public.grant_weekly_allowance(integer) to service_role;
grant execute on function public.evaluate_feedback_eligibility(uuid) to service_role;

-- These same three MUST be revoked from `authenticated`, and that is not implied
-- by anything above. The Supabase image's default privileges grant EXECUTE on
-- every new function to `authenticated` at CREATE time, so omitting an explicit
-- revoke does not mean "not granted" — it means "granted to everyone signed in".
-- Without this a member could call `release_held_credits()` to release their own
-- held Credits early, collapsing the review window that exists so an abusive
-- feedback item can be reversed before it is spent.
revoke execute on function public.release_held_credits() from authenticated;
revoke execute on function public.grant_weekly_allowance(integer) from authenticated;
revoke execute on function public.evaluate_feedback_eligibility(uuid) from authenticated;

-- Internal helpers are not part of the member-facing API. They stay callable by
-- the app roles only where a policy genuinely needs them: `is_admin`,
-- `can_view_entry*` and `app_setting_int` are used from inside RLS policies,
-- which execute as the policy's role, so their EXECUTE grant must remain.
-- `refresh_profile_reputation` is the opposite case — nothing calls it except the
-- RPCs, which are SECURITY DEFINER, so no role needs it directly.
revoke execute on function public.refresh_profile_reputation(uuid) from authenticated;
revoke execute on function public.unique_handle_from_email(text) from authenticated;

-- Final word on EXECUTE, deliberately placed AFTER the grants above.
--
-- Two revocations are needed, and the second is the one that actually matters:
--
--   from PUBLIC  Postgres grants EXECUTE to PUBLIC on every new function by
--                default. `anon` inherits that, so `has_function_privilege('anon', …)`
--                stays true unless the PUBLIC grant itself is removed.
--   from anon    This stack's Supabase image *additionally* installs
--                `alter default privileges … grant all on functions to anon`, so
--                `anon` holds a direct grant too. Removing PUBLIC is not enough.
--
-- The explicit grants to `authenticated` and `service_role` above are separate ACL
-- entries and are unaffected by either revocation, which is why this can safely
-- run last rather than before them.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop policy if exists moderation_actions_admin_read on public.moderation_actions;
-- drop policy if exists moderation_reports_admin_update on public.moderation_reports;
-- drop policy if exists moderation_reports_insert_own on public.moderation_reports;
-- drop policy if exists moderation_reports_read_own on public.moderation_reports;
-- drop policy if exists duration_events_insert_own on public.duration_events;
-- drop policy if exists duration_events_own on public.duration_events;
-- drop policy if exists mutes_admin_all on public.mutes;
-- drop policy if exists mutes_write_own on public.mutes;
-- drop policy if exists mutes_read_own on public.mutes;
-- drop policy if exists feed_signals_admin_all on public.feed_signals;
-- drop policy if exists feed_signals_write_own on public.feed_signals;
-- drop policy if exists feed_signals_read_own on public.feed_signals;
-- drop policy if exists feed_impressions_admin_all on public.feed_impressions;
-- drop policy if exists feed_impressions_insert_own on public.feed_impressions;
-- drop policy if exists feed_impressions_read_own on public.feed_impressions;
-- drop policy if exists outbound_clicks_admin_all on public.outbound_clicks;
-- drop policy if exists outbound_clicks_insert_own on public.outbound_clicks;
-- drop policy if exists outbound_clicks_read_own on public.outbound_clicks;
-- drop policy if exists reputation_ledger_read on public.reputation_ledger;
-- drop policy if exists feedback_ratings_admin_all on public.feedback_ratings;
-- drop policy if exists feedback_ratings_read on public.feedback_ratings;
-- drop policy if exists feedback_admin_all on public.feedback;
-- drop policy if exists feedback_update_own on public.feedback;
-- drop policy if exists feedback_insert_own on public.feedback;
-- drop policy if exists feedback_read on public.feedback;
-- drop table if exists public.weekly_allowance_runs;
-- drop policy if exists credit_ledger_admin_all on public.credit_ledger;
-- drop policy if exists credit_ledger_read_own on public.credit_ledger;
-- drop function if exists public.can_view_entry_hashtags(uuid, uuid);
-- drop function if exists public.can_view_entry(uuid, uuid);
