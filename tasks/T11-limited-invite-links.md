# T11 — Limited-Use Invite Links (`/join/{invite-code}`)

**Status:** Complete
**Depends on:** T03
**Blocks:** —
**Brief reference:** §Include "Invite-only authentication" — extended with shareable, capped invitation links for growing a community one batch at a time.

---

## 1. Goal

Add a second kind of invitation: a **short, shareable, human-typeable code that a bounded number
of people may redeem**, so an admin can grow the community without collecting a list of email
addresses in advance.

An admin creates a code with a use limit, shares a URI of the form `/join/{invite-code}`, and up
to that many strangers can each create an account and start using the product.

The distinction from T03 is the whole point:

| | **Single-use invite** (T03, exists) | **Limited-use code** (T11, this task) |
| --- | --- | --- |
| Bound to | one specific email address | nobody in advance |
| Redeemable by | exactly one person | up to `max_uses` people |
| Credential | 64 hex chars, 256 bits | ~20 Crockford base-32 chars, ~100 bits |
| Path | `/invite/{token}` → `/auth/accept?token=` | `/join/{code}` → email form |
| Who may be created | the invited address only | whoever holds the link |

Both keep the same security posture: **only a digest is stored, and redemption authority lives in
a `SECURITY DEFINER` function that no client can call.**

---

## 2. Why this position in the plan

T03 built the gate but only one shape of credential: an invitation addressed to a person. That is
correct for a private community and wrong for growing it — an admin who wants to let in "five
people from a Discord thread" currently has to collect five addresses, then issue five separate
links and track five expiries.

This sits after T03 because it is an extension of the invite gate rather than a new subsystem: the
account-creation route, the redemption ordering, the rollback-on-partial-failure rule, the
onboarding handoff, and the proxy allowlist all already exist and are reused. Nothing here needs a
new system, only a new table and a parallel claim function.

It does not block anything. T04–T10 do not wait on it.

---

## 3. Scope

### In scope

- `invite_codes` + `invite_code_redemptions` tables, with RLS and the count invariant enforced by
  a constraint
- `claim_invite_code()` — atomic, single authority on redemption, service-role only
- Crockford base-32 code generation, validation, and normalisation in `@fydio/domain`
- `POST /api/auth/accept-invite-code`, modelled directly on `accept-invite`
- `/join/[code]` landing page and `/join/[code]/join` account-creation step (email form)
- `/join` added to the proxy's public prefixes
- Admin surface: a minimal `/admin/invites` page (create, list, revoke) and a
  `scripts/issue-invite-code.ts` CLI equivalent
- pgTAP coverage for the cap, concurrency, expiry, revocation and single-use-per-account

### Explicitly out of scope

- **The rest of the admin console.** T09 owns `/admin/users`, content, tags, reports and credits.
  T11 adds exactly one admin screen, `/admin/invites`, and the console assembles around it.
- **Codes that grant the `admin` role** — see §5.7. This is a deliberate refusal, not an omission.
- **Custom domains, per-code landing copy, or analytics on which codes convert.** The "who
  redeemed what" question is answered by `invite_code_redemptions`; surfacing it is T09's metrics
  work.
- **Bulk/batch codes** (one code per campaign with per-campaign analytics). A code already covers
  this; a second entity would only duplicate it.
- **Changing the T03 single-use flow.** It stays exactly as it is, including its guarantees.

---

## 4. Deliverables

1. Migration `0014_invite_codes.sql`: two tables, the count constraint, `claim_invite_code()`,
   grants, and a `down` section
2. `inviteCodeSchema` / code generation + normalisation in `packages/domain`, with tests
3. `POST /api/auth/accept-invite-code` and the read-only status helper
4. `/join/[code]` and `/join/[code]/join` pages, reusing `InviteAcceptanceCard`'s exchange
5. `/admin/invites` — create, list with remaining uses, revoke
6. `scripts/issue-invite-code.ts` — CLI equivalent, prints the link once
7. pgTAP suite `006_invite_codes.sql`, and E2E coverage of the capped journey

---

## 5. Technical design

### 5.1 A new table, not new columns on `invites`

The obvious move is to add `max_uses`/`used_count` to `invites` and relax its constraints. That
is refused, because `invites` cannot hold this shape without weakening T03:

```sql
-- 0002, unchanged by T11
email      citext not null unique,   -- ← the blocker
token_hash bytea   not null unique,
```

`invites.email` is `NOT NULL UNIQUE`: one address, one invitation, forever. A shared code has no
address at all. Making the column nullable to accommodate it would mean every T03 read path —
`rejectUnusableInvite`, the pre-check in `accept-invite`, `invites_read_own` RLS — now has to cope
with a row shape that has no `email`, and "exactly one account per invitation" would become "at
most one account per *non-null* email" — a weaker statement to reason about for the rest of the
project.

A second table keeps the two credentials genuinely separate. `invites` stays a single-use,
address-bound secret; `invite_codes` is a capped, address-free counter. Nothing in T03 changes,
and no code path can read one as the other.

### 5.2 The code format, and why entropy carries the load

This is the most important decision in the task, so the reasoning is spelled out.

**T03's token is 32 random bytes (256 bits).** An attacker cannot guess it, so T03 can store only
its digest and rely on the digest being useless. A *short, typeable* code is different in kind,
and it is worth being precise about where its security comes from:

- **Online guessing** (an attacker has the URL and is trying codes against the live app) is
  bounded by request throughput. 60 bits is already infeasible.
- **Offline guessing** (a database leaks; the attacker holds `code_hash` and a GPU) is bounded by
  hash speed — order 10⁹/s. Here 60 bits is **not** safe (~36 years); 80 bits is ~38 million
  years; 100 bits is not a thing an attacker does.

So **hashing a short code does not protect it**, and the honest consequence is that entropy, not
secrecy at rest, is what makes a code safe. That is the opposite of T03's posture, and it is why
the length is chosen by the table below rather than by taste.

**Format: Crockford base-32.** Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — no `I`, `L`, `O` or
`U`, so a misread `1`/`I` or `0`/`O` cannot silently become a different (and possibly valid) code.
Normalisation upper-cases and folds those four excluded letters onto their look-alikes *before*
hashing, so someone typing the link by hand is not punished for their keyboard.

| Length | Bits | Offline crack at 10⁹/s | Verdict |
| --- | --- | --- | --- |
| 10 | 50 | ~4 minutes | **Rejected** |
| 12 | 60 | ~36 years | **Rejected** |
| 16 | 80 | ~38 million years | Minimum |
| 20 | 100 | not a thing | **Default** |

The floor is enforced by the database, not by the UI — see `code_length` in §5.3 — because the
length cannot be recovered from a hash and therefore cannot be re-checked at redemption.

### 5.3 Schema

```sql
create table public.invite_codes (
  id uuid primary key default gen_random_uuid(),

  -- Admin-facing note ("march newsletter"). Never shown to members, and never
  -- constrained to be unique -- two batches may legitimately share a label.
  label text,

  -- SHA-256 of the normalised code, never the code. See 5.2: this protects
  -- against casual disclosure, NOT against a determined offline attack. That is
  -- what the length is for.
  code_hash bytea not null unique,

  -- The length the code was minted with, kept so the 16-char floor survives
  -- hashing. A `char_length` CHECK cannot read it back out of `code_hash`.
  code_length smallint not null,

  -- The cap, and the number consumed. `used_count` is authoritative for the cap
  -- and moves ONLY inside `claim_invite_code`; RLS revokes UPDATE from every
  -- other caller, so it cannot drift by hand.
  max_uses  integer not null,
  used_count integer not null default 0,

  created_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,

  constraint invite_codes_length_range
    check (code_length between 16 and 32),
  constraint invite_codes_max_uses_range
    check (max_uses between 1 and 1000),

  -- THE CAP, as a constraint. The row lock in `claim_invite_code` is the
  -- mechanism that makes it hold under concurrency; this is the invariant that
  -- makes it impossible to violate by any other route, including a future one
  -- nobody has written yet.
  constraint invite_codes_used_within_max
    check (used_count between 0 and max_uses)
);

create index invite_codes_created_at_idx on public.invite_codes (created_at desc);

-- One row per person who joined through a code.
--
-- `unique (user_id)` is a product invariant, not a de-duplication detail: an
-- account may be created through AT MOST ONE invite code, ever. Without it a
-- person could hold several shared links and mint an account from each.
create table public.invite_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_code_id uuid not null references public.invite_codes (id) on delete cascade,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  redeemed_at    timestamptz not null default now(),

  constraint invite_code_redemptions_one_per_user unique (user_id)
);

create index invite_code_redemptions_code_idx
  on public.invite_code_redemptions (invite_code_id);
```

**ON DELETION DOES NOT RETURN THE SLOT.** Both FKs cascade, so deleting an account removes its

### 5.4 `claim_invite_code()` — the single authority on redemption

Structurally identical to T03's `claim_invite`, and for the same reason: redemption authority
lives in one `SECURITY DEFINER` function, granted to `service_role` and to nobody else.

The difference is that this one has a **counter**, so the row lock is load-bearing in a way
`claim_invite`'s single-use flag is not.

```sql
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
  -- committed, and therefore sees the updated value. Without it, two redemptions arriving
  -- together both read "1 of 1 remaining" and both succeed — the cap would hold for sequential
  -- use and fail under exactly the load it exists to handle.
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
```

Note what is **absent**: there is no `update public.profiles set role = ...`. See §5.7.

```sql
-- Grants, written out rather than inherited.
--
-- THE ORDER MATTERS, AND THE LAST LINE IS THE ONE THAT MATTERS MOST.
--
-- This Supabase image installs `alter default privileges in schema public grant execute on
-- functions to postgres, anon, authenticated, service_role`. Every function created above was
-- therefore granted EXECUTE to `anon` AND `authenticated` at CREATE time -- an EXPLICIT grant,
-- not the implicit PUBLIC one.
--
-- So `revoke ... from public` is not sufficient: it removes the PUBLIC grant and leaves the
-- explicit one untouched. Verified against this stack -- with only the `public` and `anon`
-- revokes, `has_function_privilege('authenticated', 'public.claim_invite_code(text,uuid)',
-- 'execute')` returns TRUE, and every signed-in member can mint themselves an account without
-- ever touching the HTTP route. The cap would hold; the invite gate would not.
--
-- Hence the shape below: revoke the blanket grants, grant service_role, and THEN revoke
-- `authenticated` explicitly -- after the grant, which is what T03's `claim_invite` does and
-- why it works. `pg_proc.proacl` for the result must be exactly
-- `postgres=X/postgres, service_role=X/postgres`.
revoke execute on function public.claim_invite_code(text, uuid) from public;
revoke execute on function public.claim_invite_code(text, uuid) from anon;

grant execute on function public.claim_invite_code(text, uuid) to service_role;
revoke execute on function public.claim_invite_code(text, uuid) from authenticated;
```

### 5.5 RLS

```sql
-- WITHOUT THESE TWO LINES THE POLICIES BELOW ARE INERT.
--
-- A table with RLS *disabled* ignores its policies entirely and is readable and writable by
-- anyone holding the anon key through PostgREST. Adding a policy first and enabling RLS later is
-- the order that turns "I wrote the policy" into "the policy is enforced".
alter table public.invite_codes            enable row level security;
alter table public.invite_code_redemptions enable row level security;

-- Admins read and manage codes; members read none of them.
create policy invite_codes_admin_all on public.invite_codes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Redemptions: an admin may read them; nobody writes them outside the
-- SECURITY DEFINER function above. A member cannot read even their OWN redemption,
-- because "which batch did this person join from" is not theirs to see and is not
-- needed anywhere in the product.
create policy invite_code_redemptions_admin_read on public.invite_code_redemptions
  for select to authenticated
  using (public.is_admin());
```

`invite_codes` gets **no SELECT policy for `authenticated` members** and **no policy at all for
`anon`** — an anonymous visitor holding a link has no session and so no way to read the row. The
status check the landing page needs is therefore a server-side read with the service key, never a
client query (§5.8).

**A NOTE ON `has_table_privilege('anon', 'invite_codes', 'select')` RETURNING TRUE.** It does, and
that is not a hole. Supabase's default privileges grant the *table* privileges to `anon`, and RLS
is what denies the rows. Verified on this stack: with RLS enabled and no `anon` policy,
`set role anon; select count(*) from invite_codes` returns 0.

This matters because a reviewer auditing grants will find `anon` holding SELECT and reasonably
worry. The reason to leave it is that a table with RLS enabled and zero policies is deny-by-
default, which is a stronger and more legible guarantee than a grant matrix full of revokes — and
the pgTAP suite asserts the *result* (no rows), not the absence of a privilege string.
redemption row — but `used_count` is *not* decremented, because there is no code path that
decrements it. The ledger is an audit trail that can shrink; the cap never moves backwards. An
admin who needs more room mints a new code. This asymmetry is stated rather than prevented,
because making it consistent would mean a tombstone row that outlives the account and a trigger to
keep a counter in sync with it — real complexity for a case (an admin deleting the account of
someone who joined via a code) where the honest answer is "issue another code".

### 5.6 `POST /api/auth/accept-invite-code`

A deliberate mirror of T03's `accept-invite`, including its ordering, because the ordering *is*
the design:

```
1. normalise + shape-check the code         (a mangled code never reaches the DB)
2. read the code by digest: live?          ← pre-check, so no account is created
   not revoked / not expired / has a slot     for a link that cannot work
3. address already registered? reject       ← refuse BEFORE claiming, so a
   with "you already have an account"         failure never burns a slot
4. create the auth user for that address
5. claim_invite_code  — the atomic cap check
6. issue a one-time session
```

Steps 2 and 3 are conveniences that produce a specific message and avoid creating an account for
a doomed request. **Step 5 is the authority** and re-checks everything inside the transaction.

**Step 4→5 has no shared transaction** — GoTrue and Postgres cannot commit together — so a
failure in step 5 deletes the account created in step 4, exactly as T03 does. T03's note on why is
worth repeating because it is easy to get wrong: an orphan account holding a proven email address
locks the person out of an address they have already demonstrated they control, which is strictly
worse than a failed redemption.

Error mapping reuses T03's `CLAIM_ERRORS` shape:

| SQLSTATE | Status | Message |
| --- | --- | --- |
| `P0002` | 404 | That invite link is not valid. |
| `23514` | 410 | That invite link has expired or been revoked. |
| `23505` | 410 | Everyone this link was shared with has already joined. |
| `23505` (pre-check) | 409 | That address already has a Fydio account. |

### 5.7 Why a code can never grant `admin`

`claim_invite` promotes a recipient to the role the invitation carries, and that is how an admin
invites another admin. Applying the same behaviour to a shared code would mean **N strangers
become admins** — not a risk worth taking for a capability nobody asked for.

So `claim_invite_code` creates members, always. An admin who needs another admin issues a normal
single-use invite with `--role admin`, which stays address-bound and single-use — the safe shape
for the dangerous capability. This is a decision rather than an unimplemented flag, because a
`role` column on `invite_codes` defaulting to `member` is exactly the kind of thing that gets
wired up later without anyone re-reading the threat model.

### 5.8 Reading a code's status without consuming it

The `/join/[code]` landing page must know whether the link is live *before* asking for an email —
otherwise it collects addresses from dead links.

That check is a **server-side read with the service key** in `src/lib/invite-code.ts`, called from
the server component. It is never a client query, because §5.5 grants members no read on the
table.

**The page does not display the remaining count.** Showing "3 of 5 used" to any visitor turns the
landing page into a cheap oracle that confirms a guessed code is real, and no stranger needs to
know how much room is left — the person sharing it already knows, and admins see the real number
in `/admin/invites`. The page says "this link is available", or gives the specific reason it is
not.

### 5.9 The two routes

### 5.10 Admin surface

Two ways to mint a code, for two different callers.

**`/admin/invites`** — a single screen: a form (label, max uses, expiry), a list of codes with
label / uses remaining / expiry / created-at, and a revoke action. Gated by `is_admin()`; the
existing `ADMIN_PREFIX` constant in `proxy.ts` is already reserved for `/admin`, so the gate has a
home. Every read and write goes through the service client **after** the admin check, matching the
convention in `issue-invite.ts`.

**`scripts/issue-invite-code.ts`** — the CLI equivalent, mirroring `issue-invite.ts`:

```bash
pnpm --filter @fydio/web invite:code --uses 5 --label "march newsletter" --days 14
```

```bash
pnpm --filter @fydio/web invite:code --uses 3

# created  label: (none)  uses: 3/3  expires: 2026-04-24T12:00:00.000Z

#   link:  http://localhost:3000/join/K4M9QR7XZ2AB8HJTC5VNWY0PD

#   This link is shown ONCE. Only its SHA-256 digest is stored.
```

The raw code is printed exactly once, for the same reason as T03: only the digest is persisted,
so it cannot be recovered later. The difference is that losing a code here is *less* serious —
the admin can mint another, and nobody is left holding a dead address-bound invite.

### 5.11 Client-side validation

In `@fydio/domain`, beside the existing `handleSchema` / `hashtagSchema`:
---

## 6. Files to create

| Path | Purpose |
| --- | --- |
| `supabase/migrations/0014_invite_codes.sql` | Tables, constraints, `claim_invite_code()`, RLS, grants |
| `supabase/tests/006_invite_codes.sql` | pgTAP: cap, concurrency, expiry, revoke, one-per-user |
| `packages/domain/src/invite-code.ts` | Alphabet, normaliser, schema, generator |
| `packages/domain/src/invite-code.test.ts` | Normalisation, length floor, alphabet rejection |
| `apps/web/src/lib/invite-code.ts` | Server-only: status read, hashing helpers |
| `apps/web/src/app/api/auth/accept-invite-code/route.ts` | Redemption route |
| `apps/web/src/app/(auth)/join/[code]/page.tsx` | Landing page |
| `apps/web/src/app/(auth)/join/[code]/join/page.tsx` | Email form + redemption |
| `apps/web/src/app/(auth)/join/[code]/join/JoinCodeForm.tsx` | Client form + fragment exchange |
| `apps/web/src/app/(admin)/admin/invites/page.tsx` | Admin list + revoke |
| `apps/web/src/app/(admin)/admin/invites/actions.ts` | Server actions, gated by `is_admin()` |
| `apps/web/src/app/(admin)/admin/invites/IssueInviteCodeForm.tsx` | Client form |
| `apps/web/scripts/issue-invite-code.ts` | CLI equivalent |
| `apps/web/test/e2e/join.spec.ts` | E2E: `/join/{code}` → account → onboarding; exhausted |

Modified: `apps/web/src/proxy.ts` (`PUBLIC_PREFIXES`), `packages/domain/src/index.ts` (export),
`apps/web/package.json` (script), `tasks/README.md` (index row).

| Route | Purpose |
| --- | --- |
| `/join/[code]` | Landing page. Validates the code server-side, explains Fydio, links onward. **Does not redeem.** |
| `/join/[code]/join` | Email form → `POST /api/auth/accept-invite-code` → same fragment-based session exchange as `InviteAcceptanceCard` |

The landing page does **not** redirect automatically, for T03's reason: `/invite/[token]` exists
so a link that is merely *clicked* — or link-previewed by a corporate mail scanner — cannot
create an account. Redemption stays behind a deliberate render and an explicit click.

The raw code is carried from the landing page to the form in the **query string**, not the path,
for the same reason T03 does it: a fragment never reaches the server, and the accept step must be
able to render it.

Both pages set `robots: { index: false }` and a `noindex` referrer policy. A shared code in a
`Referer` header sent to any third party is a leaked credential, and search-engine indexing of a
working invite link is an invitation to scrapers.

`/join` is added to `PUBLIC_PREFIXES` in `src/proxy.ts` alongside `/invite`. It must be a prefix
so `/join/<code>/join` is covered too.

## 7. Implementation steps

- [ ] Add `inviteCodeSchema`, `normalizeInviteCode`, `generateInviteCode` to `@fydio/domain` with
      unit tests — including one asserting generated codes never contain `I`, `L`, `O` or `U`
- [ ] Migration `0014`: `invite_codes`, `invite_code_redemptions`, the `used_count` constraint
- [ ] Migration `0014`: `claim_invite_code()` with the `for update` lock, plus the grants block
- [ ] Migration `0014`: RLS policies; confirm `anon` cannot select either table
- [ ] `src/lib/invite-code.ts` — status read + hashing helpers beside the T03 ones
- [ ] `POST /api/auth/accept-invite-code`, mirroring `accept-invite`'s ordering and rollback
- [ ] `/join/[code]` landing page — `noindex`, neutral wording, no remaining count
- [ ] `/join/[code]/join` email form, reusing `InviteAcceptanceCard`'s fragment exchange
- [ ] Add `/join` to `PUBLIC_PREFIXES`; confirm the proxy gates it and `/api/**` stays exempt
- [ ] `scripts/issue-invite-code.ts`; add the `invite:code` script
- [ ] `/admin/invites` — issue, list, revoke, behind `is_admin()`
- [ ] pgTAP suite `006_invite_codes.sql`, including the concurrent last-slot test
- [ ] E2E `join.spec.ts`

---

## 8. Acceptance criteria

- [ ] A code with `max_uses = 3` creates exactly three accounts; the fourth attempt is refused
      with "everyone this link was shared with has already joined"
- [ ] **Concurrent** redemptions of the last remaining slot produce exactly one account — the cap
      holds under parallel load, not only sequential use
- [ ] A code cannot be redeemed after `expires_at`, and not at all after `revoked_at`
- [ ] Only `code_hash` is stored — a scan of every column for the raw code finds nothing
- [ ] A code shorter than 16 characters is rejected by the **database**, not merely by the form
- [ ] Normalisation makes `k4m9…`, `K4M9…`, and a variant with `O`/`I` for `0`/`1` the same code
- [ ] A member cannot read `invite_codes` or `invite_code_redemptions`, as `anon` or as a
      signed-in non-admin
- [ ] `claim_invite_code` is not executable by `anon` or `authenticated`
- [ ] **A code can never produce an `admin`** — no `role` column on `invite_codes`, and the
      function never touches `profiles.role`
- [ ] One account cannot be created from two different codes
- [ ] A failed claim leaves no orphan account holding the address
---

## 9. Tests

- **Unit** (`@fydio/domain`): normalisation (case, the four excluded letters, whitespace),
  rejection of every non-alphabet character, the 16/32 length bounds, and that generated codes
  never contain `I`, `L`, `O` or `U`
- **pgTAP** (`006_invite_codes.sql`): exactly *N* of *N* succeed; the *(N+1)*th fails with
  `23505`; revoke and expiry are refused; the `used_count` CHECK rejects a hand-written overrun;
  one account cannot claim twice; **and two sessions racing for the last slot, where exactly one
  wins**

  Plus two privilege assertions, because they are the ones that are easy to get wrong and are
  invisible until exploited:

  ```sql
  select has_function_privilege('anon',          'public.claim_invite_code(text,uuid)', 'execute') is false;
  select has_function_privilege('authenticated', 'public.claim_invite_code(text,uuid)', 'execute') is false;
  select has_function_privilege('service_role',  'public.claim_invite_code(text,uuid)', 'execute') is true;

  -- Belt and braces on the grants block above: this is the exact ACL T03's claim_invite has.
  select array_to_string(proacl, ', ') = 'postgres=X/postgres, service_role=X/postgres'
    from pg_proc where proname = 'claim_invite_code';
  ```

  and, with `set role anon`, that `invite_codes` returns zero rows despite `anon` holding the
  table-level SELECT grant.
- **Integration** (`apps/web/test`): valid code → account + session; exhausted code → 410 and no
  account created; existing address → 409 and no slot consumed
- **E2E** (Playwright): `/join/{code}` → email → account → five-step onboarding → profile; a
  second member taking the last slot; a third being refused

**The concurrency test matters most.** Everything else here could pass against an implementation
whose cap only holds for sequential use — precisely the case the cap exists to prevent.

- `INVITE_CODE_ALPHABET` — the 32 Crockford symbols
- `normalizeInviteCode(raw)` — trim, upper-case, fold `I`→`1`, `L`→`1`, `O`→`0`, `U`→`V`, reject
  anything else
- `inviteCodeSchema` — normalised, `16–32` chars, Crockford alphabet
- `generateInviteCode(length)` — CSPRNG-backed, unbiased (see below)

**Sampling must be unbiased.** `Math.random()` is not a CSPRNG, and a naive `byte % 32` is only
uniform while `256` is a multiple of `32` — true today, silently false the day the alphabet
changes. Rejection-sample from the byte range instead, so generation does not depend on the
alphabet size at all.

---

## 10. Verification commands

```bash
pnpm db:reset
pnpm db:test                                    # 006_invite_codes.sql included
pnpm --filter @fydio/domain test                # normalisation + generation
pnpm --filter @fydio/web test                   # HTTP journey
pnpm validate
pnpm --filter @fydio/web build

# Mint a code, then try to redeem it twice with a cap of 1
pnpm --filter @fydio/web invite:code --uses 1 --days 1
curl -sX POST http://localhost:3000/api/auth/accept-invite-code \
  -H 'content-type: application/json' \
  -d '{"code":"<code>","email":"first@example.test"}'
curl -sX POST http://localhost:3000/api/auth/accept-invite-code \
  -H 'content-type: application/json' \
  -d '{"code":"<code>","email":"second@example.test"}'   # expect 410

# The cap, as the database sees it
psql "$DATABASE_URL" -c \
  "select label, max_uses, used_count, expires_at > now() as live from invite_codes order by created_at desc limit 5;"

# Nothing raw on disk
psql "$DATABASE_URL" -c "select encode(code_hash,'hex') from invite_codes order by created_at desc limit 5;"

pnpm --filter @fydio/web test:e2e --grep join
```

---

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| **Slots burned by people who never join.** Anyone with the link can consume slots; a link in a public channel is spent in minutes | Inherent to "anyone with the link may join", which is what is being asked for. Bounded by `max_uses`, a short default expiry, revoke, and per-IP throttling on the accept route. A stricter variant — reserve the slot, then confirm the email before creating the account — removes it almost entirely at the cost of one extra email step; recorded in §13, not built |
| **Brute-forced code** | 100-bit default, 80-bit enforced floor. Online guessing is infeasible; the hash does *not* defend against offline guessing, which is exactly why the length is the control. Per-IP throttling is the second layer, not the first |
| **Cap exceeded under concurrency** | `for update` on the code row inside the claim function, plus a `used_count <= max_uses` CHECK. Tested with two concurrent sessions, because a sequential test cannot observe this class of bug |
| **An open signup path appears by accident** | `claim_invite_code` is service-role only, the redemption route is its only caller, and pgTAP asserts `anon`/`authenticated` cannot execute it. Mirrors the T03 guarantee |
| **Silent role escalation** | No `role` column on `invite_codes`; the function never writes `profiles.role`. Admin grants stay address-bound and single-use |
| **Account created without a claim** (GoTrue and Postgres share no transaction) | Roll the account back on claim failure, as T03 does; log loudly if the rollback itself fails |
| **Two accounts from one address across codes** | `unique (user_id)` on redemptions, plus a pre-check in the route so the common case never reaches the database |
| **Code leaks via `Referer` or indexing** | `noindex` + a referrer policy on `/join/*`; the page loads no third-party resources |
| **Admin mints `max_uses = 999`** | Range CHECK caps it at 1000 and the UI suggests a range; a large batch should be several codes so it can be revoked piecemeal |
| **T03 regressions from shared files** | `proxy.ts` and `packages/domain` are the only shared edits; every T03 suite still runs |

---

## 12. Definition of done

An admin can create a code with a use limit, copy a `/join/{invite-code}` URI, and have exactly
that many people create accounts and reach onboarding — with the cap enforced by a database
constraint rather than by the UI, the raw code stored nowhere, and no path by which a code can
create an admin.

---

## 13. Open questions for the operator

1. **Default expiry.** 14 days is proposed. A code shared in a newsletter should probably outlive
   the newsletter's readership window; a code shared in a Discord channel should not.
2. **Burn-on-claim vs. confirm-then-claim.** Reserving a slot and confirming the email before
   creating the account would make slots essentially unburnable, at the cost of one extra email
   round-trip. The design here creates the account immediately, matching T03. Worth a decision
   before launch.
3. **Does a code member need an email round-trip at all?** Today the account is created from the
   address typed at `/join`. That matches T03 (no passwords anywhere) but a typo creates an
   account nobody can later reach. Confirm that is acceptable, or make step 4 of §5.6 a magic-link
   confirmation first.
4. **Default `max_uses`.** None is proposed — the form requires an explicit number, because a
   wrong default hands out unintended access the moment a link is shared.
- [ ] An address that already has an account is refused **without** consuming a slot
- [ ] `/join/[code]` reveals no usage count and is `noindex`
- [ ] T03's single-use invite flow is unchanged and still passes its own tests

---
