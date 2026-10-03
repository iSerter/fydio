-- =============================================================================
-- T02 · 0008 — Telemetry and moderation
-- =============================================================================
--
-- Outbound clicks, opt-in coarse duration bands, and the moderation tables.
--
-- THE PRIVACY RULE, STATED ONCE. `duration_events` is private to the member who
-- produced it (RLS in 0009, `force row level security` too), is coarse to the
-- point of being useless for surveillance, and earns nothing. It exists so a
-- member can see their OWN history, and it is never joined into anything that
-- scores another member.

create table public.outbound_clicks (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.content_entries (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  clicked_at timestamptz not null default now(),
  client text,
  source text,

  -- Opaque token so the return leg can be correlated with this click without
  -- exposing which member clicked. T08 signs it; it carries no identity.
  return_token text
);

create index outbound_clicks_entry_user_idx on public.outbound_clicks (entry_id, user_id, clicked_at desc);

-- --- Duration events ---------------------------------------------------------------
--
-- Opt-in only. `consent_version` records WHICH version of the extension's consent
-- text the member agreed to, so withdrawing consent later cannot be confused with
-- never having agreed.

create table public.duration_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  entry_id uuid not null references public.content_entries (id) on delete cascade,

  band duration_band not null,
  returned boolean,
  consent_version text not null,
  received_at timestamptz not null default now()
);

-- Private history: queried only ever by (user_id, entry_id).
create index duration_events_user_idx on public.duration_events (user_id, received_at desc);

-- --- Moderation ------------------------------------------------------------------------

create table public.moderation_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,

  -- Polymorphic target. `target_id` is text because it points at rows in four
  -- different tables with no single FK that would hold across all of them; the
  -- CHECK below keeps the column honest about being non-empty.
  target_type report_target not null,
  target_id text not null,

  reason text not null,
  details text,

  state report_state not null default 'open',
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution_note text,

  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  constraint moderation_report_target_id_present check (char_length(target_id) > 0),
  constraint moderation_report_details_len check (details is null or char_length(details) <= 2000),
  constraint moderation_report_reason_len check (char_length(reason) between 3 and 200),

  -- A resolved report must say who resolved it and when; an open one must not
  -- pretend to be resolved.
  constraint moderation_report_resolution_consistent check (
    (state in ('open', 'reviewing') and resolved_at is null and resolved_by is null) or
    (state in ('resolved', 'dismissed') and resolved_at is not null and resolved_by is not null)
  )
);

create index moderation_reports_state_idx on public.moderation_reports (state, created_at desc);
create index moderation_reports_target_idx on public.moderation_reports (target_type, target_id);

-- One open report per member per target: a second report is noise, and without
-- this a member could flood the moderation queue by resending.
create unique index moderation_reports_one_open_per_target_idx
  on public.moderation_reports (reporter_id, target_type, target_id)
  where state in ('open', 'reviewing');

-- --- moderation_actions: the immutable audit trail -------------------------------------
--
-- Append-only, like both ledgers. Moderation decisions are the kind of thing a
-- community disputes weeks later, so "who hid this, when, and on whose authority"
-- has to remain answerable.

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  target_type report_target not null,
  target_id text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index moderation_actions_target_idx on public.moderation_actions (target_type, target_id, created_at desc);
create index moderation_actions_actor_idx on public.moderation_actions (actor_id, created_at desc);

create or replace function public.moderation_actions_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'moderation_actions is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger moderation_actions_append_only_trg
  before update or delete on public.moderation_actions
  for each row execute function public.moderation_actions_append_only();

-- --- record_outbound_click -------------------------------------------------------------
--
-- Records the open event AND marks the entry opened in one call. Doing both here
-- rather than in two RPCs means there is no window in which a click is recorded but
-- the entry is not marked — and `submit_feedback` requires that mark to exist.

create or replace function public.record_outbound_click(
  p_entry_id uuid,
  p_client   text default null,
  p_source   text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_click  uuid;
  v_token  text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.content_entries where id = p_entry_id and status = 'active') then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  -- Signed by the member's id so the return leg can prove which click it refers
  -- to. T08 verifies it with the same secret; it is not a bearer token and
  -- grants no access on its own.
  v_token := encode(extensions.digest(v_uid::text || p_entry_id::text || extract(epoch from clock_timestamp())::text, 'sha256'), 'hex');

  insert into public.outbound_clicks (entry_id, user_id, client, source, return_token)
  values (p_entry_id, v_uid, p_client, p_source, v_token)
  returning id into v_click;

  perform public.mark_entry_opened(p_entry_id);

  -- Return the click id: it identifies the event without revealing the member's id
  -- to the extension, which only ever needs to correlate its own return leg.
  return v_click;
end;
$$;

-- --- record_duration_event ---------------------------------------------------------------

create or replace function public.record_duration_event(
  p_entry_id        uuid,
  p_band            duration_band,
  p_consent_version text,
  p_returned        boolean default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if coalesce(nullif(trim(p_consent_version), ''), '') = '' then
    raise exception 'Duration telemetry requires explicit consent'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.duration_events (user_id, entry_id, band, returned, consent_version)
  values (v_uid, p_entry_id, p_band, p_returned, p_consent_version)
  returning id into v_id;

  return v_id;
end;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.record_duration_event(uuid, duration_band, text, boolean);
-- drop function if exists public.record_outbound_click(uuid, text, text);
-- drop table if exists public.moderation_actions;
-- drop table if exists public.moderation_reports;
-- drop table if exists public.duration_events;
-- drop table if exists public.outbound_clicks;
