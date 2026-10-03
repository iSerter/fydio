-- =============================================================================
-- T02 · 0004 — Credit ledger
-- =============================================================================
--
-- Fydio Credits: earnable by contributing eligible feedback, spendable to put an
-- entry in the shared feed. This file owns the accounting.
--
-- =============================================================================
-- THE BALANCE FORMULA — READ THIS BEFORE CHANGING ANYTHING HERE
-- =============================================================================
--   balance = sum(delta) WHERE status IN ('available', 'spent')
--
-- The task text proposed `status IN ('available','held')`. That formula does not
-- work, and the failure is silent rather than loud. A submission spends by
-- inserting a row with a NEGATIVE delta and `status = 'spent'`. Under the
-- proposed filter that row is excluded from the sum, so its -1 is never
-- subtracted. A member with a 3-Credit weekly allowance would see the balance
-- stay at 3 forever and could submit without limit — the exact abuse the credit
-- economy exists to prevent, while every individual statement looked correct.
--
-- The rule each status follows:
--
--   held       contributes NOTHING.  Pending its review window.
--   available  contributes `delta`.  A grant, spendable.
--   spent      contributes `delta`.  An outflow — this is the row that makes a
--                                    submission actually cost something.
--   reversed   contributes NOTHING.  The movement it recorded was undone.
--
-- So the sum runs over `available` and `spent`: positive grants still standing,
-- minus every outflow already made. Held credits are excluded on purpose — the
-- brief holds newly earned credits for a review window precisely so an abusive
-- feedback item cannot be spent before it can be reversed.
--
-- A reversal therefore FLIPS THE ORIGINAL ROW to `reversed` (removing its
-- contribution) rather than inserting a negative sibling. Inserting a sibling
-- too would subtract twice. The paired audit row — the one `reverses_id` points
-- at — is also marked `reversed`, so it contributes nothing and exists purely as
-- evidence. `002_credits.sql` asserts each of these transitions numerically.
--
-- =============================================================================

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Signed: positive earns, negative spends.
  delta integer not null,

  kind credit_kind not null,
  status ledger_status not null,

  -- Provenance. Both nullable: a weekly allowance belongs to no entry, and an
  -- admin grant may belong to neither.
  --
  -- The foreign keys are added in 0006 rather than declared here: a FK needs its
  -- target table to exist at DDL time, and `content_entries` / `feedback` are
  -- created in 0005 and 0006. Declaring the columns now and constraining them
  -- there keeps every migration independently applicable in order, instead of
  -- forward-referencing a table that does not exist yet.
  entry_id uuid,
  feedback_id uuid,

  -- When a held credit becomes spendable. Null for rows that are never held.
  available_at timestamptz,

  created_by uuid references public.profiles (id) on delete set null,
  note text,

  -- The reversal pairing. Self-referential so the audit trail is navigable in
  -- both directions.
  reverses_id uuid references public.credit_ledger (id) on delete set null,

  created_at timestamptz not null default now(),

  -- A held row is the only kind that needs a release time; every other row would
  -- be storing a value nothing reads.
  constraint credit_held_needs_release_time check (
    (status = 'held' and available_at is not null) or status <> 'held'
  ),

  -- A reversal row must say what it reverses, and a non-reversal must not invent
  -- one. Without this, "reversed" rows could appear with no traceable cause.
  constraint credit_reversal_pairing check (
    (kind in ('admin_reverse', 'hold_reversal', 'entry_removed_reversal')) = (reverses_id is not null)
  ),

  -- A reversal must be strictly negative, and must never point at itself.
  --
  -- (The self-reference check is `reverses_id is distinct from id`, not a
  -- comparison against `delta` — `reverses_id` is a uuid and `delta` an integer,
  -- so comparing the two is a type error rather than a self-reference test.)
  constraint credit_reversal_is_negative check (reverses_id is null or delta < 0),
  constraint credit_reversal_not_self check (reverses_id is distinct from id)
);

create index credit_ledger_user_status_idx on public.credit_ledger (user_id, status);
create index credit_ledger_user_kind_time_idx on public.credit_ledger (user_id, kind, created_at desc);
create index credit_ledger_feedback_idx on public.credit_ledger (feedback_id) where feedback_id is not null;
-- Partial index for the sweeper: it only ever scans rows past their release time.
create index credit_ledger_hold_due_idx on public.credit_ledger (available_at) where status = 'held';

-- --- Immutability: `delta` and `kind` are write-once -------------------------
--
-- The ledger is an audit trail. If a row's amount can be edited after the fact,
-- no figure derived from it can be trusted, and "credits spent on submissions"
-- stops being a real number. Only `status` may move, and only forward through
-- the transitions below.

create or replace function public.credit_ledger_guard_immutability()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.delta is distinct from old.delta
     or new.kind is distinct from old.kind
     or new.user_id is distinct from old.user_id
     or new.feedback_id is distinct from old.feedback_id
     or new.entry_id is distinct from old.entry_id then
    raise exception 'credit_ledger is append-only: delta, kind and provenance cannot be edited'
      using errcode = 'insufficient_privilege';
  end if;

  -- Status may only advance along the lifecycle, never retreat. Retreating
  -- `reversed` back to `available` would resurrect a revoked credit.
  if new.status is distinct from old.status then
    if not (
      (old.status = 'held' and new.status in ('available', 'reversed')) or
      (old.status = 'available' and new.status = 'reversed')
    ) then
      raise exception 'Illegal credit_ledger status transition: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger credit_ledger_guard_immutability_trg
  before update on public.credit_ledger
  for each row execute function public.credit_ledger_guard_immutability();

-- --- The balance ---------------------------------------------------------------
--
-- SECURITY DEFINER so it can read every member's ledger rows and still answer a
-- self-or-admin question: RLS deliberately gives a member no way to read
-- another's rows, which would make a balance RPC pointless if it were not also
-- the thing that authorises the read.

create or replace function public.get_credit_balance(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if auth.uid() <> p_user_id and not public.is_admin() then
    raise exception 'Credit balances are private'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(sum(delta), 0)::integer
    into v_balance
    from public.credit_ledger
   where user_id = p_user_id
     and status in ('available', 'spent');

  return v_balance;
end;
$$;

-- --- Weekly starter-credit allowance -------------------------------------------
--
-- Every member gets a small allowance each period so a new or quiet member can
-- still participate (brief §2). Idempotent per period, which is the whole point:
-- the sweeper may retry, and a double grant would be a silent inflation of the
-- money supply. The unique `period_start` is the guard — not a check-then-insert,
-- which would race.

create table public.weekly_allowance_runs (
  period_start date primary key,
  granted_count integer not null default 0,
  amount integer not null,
  ran_at timestamptz not null default now()
);

create or replace function public.grant_weekly_allowance(p_amount integer default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('week', now() at time zone 'utc')::date;
  v_amount integer := coalesce(p_amount, public.app_setting_int('credit_weekly_starter_allowance', 3));
  v_granted integer;
begin
  -- Inserting the run row first is what makes the whole function idempotent: if
  -- this period has already been processed, the insert conflicts, we take the
  -- early exit, and nothing is granted twice.
  insert into public.weekly_allowance_runs (period_start, amount)
  values (v_period, v_amount)
  on conflict (period_start) do nothing;

  if not found then
    select granted_count into v_granted
      from public.weekly_allowance_runs
     where period_start = v_period;
    return 0;
  end if;

  insert into public.credit_ledger (user_id, delta, kind, status, note)
  select id, v_amount, 'weekly_allowance', 'available',
         'Weekly starter allowance for ' || v_period
    from public.profiles;

  update public.weekly_allowance_runs
     set granted_count = (select count(*) from public.profiles),
         ran_at = now()
   where period_start = v_period;

  return (select count(*) from public.profiles);
end;
$$;

-- --- Releasing held credits ------------------------------------------------------
--
-- Earned credits sit in `held` for a review window before they count toward a
-- balance (brief §9). This is the sweeper the T10 scheduler calls. It returns how
-- many rows it moved so the caller can log a real number rather than assuming
-- work happened.
--
-- `for update skip locked` so two overlapping sweeps cannot fight over the same
-- rows — the second simply skips them and picks up the next batch.

create or replace function public.release_held_credits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  with due as (
    select id
      from public.credit_ledger
     where status = 'held'
       and available_at <= now()
     for update skip locked
  )
  update public.credit_ledger cl
     set status = 'available'
    where cl.id in (select id from due);

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.release_held_credits();
-- drop function if exists public.grant_weekly_allowance(integer);
-- drop table if exists public.weekly_allowance_runs;
-- drop function if exists public.get_credit_balance(uuid);
-- drop table if exists public.credit_ledger;
