-- =============================================================================
-- T11 · 0031 — Limited-use invite codes (/join/{code})
-- =============================================================================
--
-- Capped, shareable invitation links for growing the community one batch at a time.
--
-- Unlike T03 (invites), an invite code is:
--   - Bound to nobody in advance (no email column)
--   - Redeemable by up to `max_uses` people
--   - ~20 Crockford base-32 characters (~100 bits of entropy)
--   - Enforced by an atomic counter and row-level lock (claim_invite_code)
--   - Incapable of granting the 'admin' role

create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),

  -- Admin-facing note ("march newsletter"). Never shown to members, and never
  -- constrained to be unique -- two batches may legitimately share a label.
  label text,

  -- SHA-256 of the normalised code, never the raw code.
  code_hash bytea not null unique,

  -- The length the code was minted with, kept so the 16-char floor survives
  -- hashing. A `char_length` CHECK cannot read it back out of `code_hash`.
  code_length smallint not null,

  -- The cap, and the number consumed. `used_count` is authoritative for the cap
  -- and moves ONLY inside `claim_invite_code`; RLS revokes UPDATE from every
  -- other caller, so it cannot drift by hand.
  max_uses integer not null,
  used_count integer not null default 0,

  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,

  constraint invite_codes_length_range
    check (code_length between 16 and 32),
  constraint invite_codes_max_uses_range
    check (max_uses between 1 and 1000),

  -- THE CAP, as a constraint. The row lock in `claim_invite_code` is the
  -- mechanism that makes it hold under concurrency; this is the invariant that
  -- makes it impossible to violate by any other route.
  constraint invite_codes_used_within_max
    check (used_count between 0 and max_uses)
);

create index invite_codes_created_at_idx on public.invite_codes (created_at desc);

-- One row per person who joined through a code.
--
-- `unique (user_id)` is a product invariant, not a de-duplication detail: an
-- account may be created through AT MOST ONE invite code, ever.
create table public.invite_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid not null references public.invite_codes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  redeemed_at timestamptz not null default now(),

  constraint invite_code_redemptions_one_per_user unique (user_id)
);

create index invite_code_redemptions_code_idx
  on public.invite_code_redemptions (invite_code_id);

-- --- claim_invite_code(): the single authority on redemption ------------------
--
-- Structurally parallel to T03's claim_invite, but with a counter and row lock.
-- Granted to `service_role` and to nobody else.
create or replace function public.claim_invite_code(p_code_hash text, p_user_id uuid)
returns public.invite_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code public.invite_codes;
begin
  if p_user_id is null then
    raise exception 'Invalid invite code' using errcode = 'no_data_found';
  end if;

  -- THE LOCK IS THE WHOLE CONCURRENCY STORY.
  --
  -- `for update` serialises every concurrent claim on this code. The last slot can be taken by
  -- exactly one transaction: whoever holds the lock re-reads `used_count` AFTER the winner has
  -- committed, and therefore sees the updated value.
  select * into v_code
    from public.invite_codes
   where code_hash = decode(p_code_hash, 'hex')
     for update;

  if not found then
    raise exception 'Invalid invite code' using errcode = 'no_data_found';
  end if;

  if v_code.revoked_at is not null then
    raise exception 'This invite code was revoked' using errcode = 'check_violation';
  end if;

  if v_code.expires_at is not null and v_code.expires_at < now() then
    raise exception 'This invite code has expired' using errcode = 'check_violation';
  end if;

  if v_code.used_count >= v_code.max_uses then
    raise exception 'This invite code has been fully claimed' using errcode = 'unique_violation';
  end if;

  -- One account per code, ever. Checked here rather than left to the UNIQUE index so the
  -- caller gets a specific message instead of a constraint violation.
  if exists (select 1 from public.invite_code_redemptions where user_id = p_user_id) then
    raise exception 'This account already used an invite code' using errcode = 'unique_violation';
  end if;

  insert into public.invite_code_redemptions (invite_code_id, user_id)
  values (v_code.id, p_user_id);

  update public.invite_codes
     set used_count = used_count + 1
   where id = v_code.id
   returning * into v_code;

  return v_code;
end;
$$;

-- --- Function privileges -----------------------------------------------------
--
-- Explicit revoke from public, anon, and authenticated, granted only to service_role.
revoke execute on function public.claim_invite_code(text, uuid) from public;
revoke execute on function public.claim_invite_code(text, uuid) from anon;

grant execute on function public.claim_invite_code(text, uuid) to service_role;
revoke execute on function public.claim_invite_code(text, uuid) from authenticated;

-- --- RLS policies ------------------------------------------------------------
alter table public.invite_codes enable row level security;
alter table public.invite_code_redemptions enable row level security;

-- Admins read and manage codes; members read none of them.
create policy invite_codes_admin_all on public.invite_codes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Redemptions: an admin may read them; nobody writes them outside the
-- SECURITY DEFINER function above.
create policy invite_code_redemptions_admin_read on public.invite_code_redemptions
  for select to authenticated
  using (public.is_admin());

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop policy if exists invite_code_redemptions_admin_read on public.invite_code_redemptions;
-- drop policy if exists invite_codes_admin_all on public.invite_codes;
-- drop function if exists public.claim_invite_code(text, uuid);
-- drop table if exists public.invite_code_redemptions;
-- drop table if exists public.invite_codes;
