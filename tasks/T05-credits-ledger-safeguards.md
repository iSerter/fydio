# T05 — Fydio Credits: Ledger, Eligibility & Anti-Abuse Safeguards

**Status:** Done
**Depends on:** T02
**Blocks:** T09
**Brief reference:** §2 Credits and submission access, §9 Credit safeguards, §Include "Separate Fydio Credits for submission access...", "Credit ledger, starter-credit allowance, contribution caps... and basic anti-abuse controls", "Keep Credit balances private in the MVP."

---

## 1. Goal

Turn the T02 ledger schema into a working credit economy: weekly starter allowances, capped and review-held earnings from eligible feedback, private balances with a transparent transaction history, and admin controls for grants, reversals, and abuse handling.

After T05 a member can see "3 Credits", earn one by leaving qualifying feedback on someone else's content, and spend one to submit.

---

## 2. Why this position in the plan

T02 built the ledger and the RPCs; this task wires the earning pipeline, the weekly allowance scheduler, the balance UI, and the credit-specific safeguards. It must precede T09 because the credit dashboard is part of the member-facing profile and admin surfaces.

---

## 3. Scope

### In scope

- Balance computation + display, private to the member (own balance only)
- Credit history (transaction list with kind, amount, status, reason)
- Weekly starter-credit allowance grant (idempotent, `weekly_allowance_runs`)
- Eligibility evaluation on feedback submission (the T02 RPC, surfaced end-to-end)
- Hold window release (sweeper callable + scheduled in T10)
- Reversal flow when feedback is removed for abuse (reverses held/available earned credits)
- Admin credit operations: grant, reverse, set a cap — each writing `moderation_actions`
- Copy that distinguishes **Credits** from **Reputation** everywhere
- Balance guards: submission form disables when balance < cost, with an explanatory state

### Explicitly out of scope

- Reputation and ratings (T06)
- The feedback UI itself (T09) — this task wires the credit side of feedback creation, which already exists as an RPC
- Any credit path tied to external platform actions — **explicitly excluded by the brief** (no credits for views, likes, follows, shares, comments, votes, or viewing time)

---

## 4. Deliverables

1. `get_credit_balance` / `get_credit_summary` RPCs wired into the UI
2. Credit balance component + history component
3. Weekly allowance RPC + idempotent scheduler entry
4. Hold-release sweeper RPC + script (`pnpm credits:release-held`)
5. Reversal-on-abuse logic tied to moderation actions
6. Admin credit operations RPCs + service-role guarded route handlers
7. Copy/UX guard so Credits are never conflated with Reputation
8. Tests for caps, holds, reversals, privacy, and the "no credit for external action" rule

---

## 5. Technical design

### 5.1 The two-signal model (the conceptual core)

The brief is emphatic: two deliberately separate community signals, never both called "points."

| System                  | Purpose                                           | Earned by                                                   | Spent?                       | Visible?                       |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ------------------------------ |
| **Fydio Credits**       | Fair access to submit content                     | Eligible peer feedback (+ weekly allowance, + admin grants) | **Yes** — 1 credit per entry | **Private** (own balance only) |
| **Feedback Reputation** | Signal of how useful a member's feedback has been | Creator ratings 1–10 (never credits)                        | **No**                       | Public (total, count, avg)     |

Implementation of the separation:

- Two separate tables (`credit_ledger`, `reputation_ledger`), two separate enums (`credit_kind`, `reputation_kind`), two separate RPC families.
- A shared TS type system with `CreditBalance` and `ReputationSummary` as **structurally incompatible** types (different fields) so they cannot be passed to each other's components.
- A naming lint (below) plus a CI grep test.

### 5.2 Balance computation

Balance = `sum(delta)` over rows whose `status in ('available','held')`. `spent` and `reversed` rows are excluded from the balance but retained for history.

```sql
create or replace function get_credit_summary(p_user_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := coalesce(p_user_id, auth.uid());
  v_role  profile_role;
  v_avail int;
  v_held  int;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='insufficient_privilege'; end if;

  v_role := (select role from profiles where id = v_uid);

  -- Credit privacy: you may only read your own balance unless you are an admin.
  if v_uid <> auth.uid() and v_role <> 'admin' then
    raise exception 'Credit balance is private' using errcode='insufficient_privilege';
  end if;

  select coalesce(sum(delta) filter (where status='available'), 0),
         coalesce(sum(delta) filter (where status='held'),     0)
    into v_avail, v_held
    from credit_ledger where user_id = v_uid;

  return jsonb_build_object(
    'available',     v_avail,
    'held',          v_held,                    -- pending review window
    'total',         v_avail + v_held,
    'submissionCost', current_setting('app.credit_submission_cost', true)::int,
    'history', coalesce((
      select jsonb_agg(row_to_json(h) order by h.created_at desc)
      from (
        select cl.created_at, cl.delta, cl.kind::text as kind,
               cl.status::text as status, cl.note,
               ce.canonical_url as entry_url, fb.id as feedback_id
        from credit_ledger cl
        left join content_entries ce on ce.id = cl.entry_id
        left join feedback fb on fb.id = cl.feedback_id
        where cl.user_id = v_uid
        limit 50
      ) h
    ), '[]'::jsonb)
  );
end $$;
```

`held` is surfaced separately from `available` so members understand why their balance "jumps" after a review window — this is the visible face of the brief's "hold newly earned Credits for a short review window."

### 5.3 Weekly starter allowance

"Every member receives a small weekly starter-credit allowance so a new or quiet member can participate."

- Runs on a **period keyed by ISO week** (`date_trunc('week', now())::date`) via `weekly_allowance_runs` for idempotency.
- Grants `CREDIT_WEEKLY_STARTER_ALLOWANCE` (default 3) to every active profile.
- New members receive it immediately on first invocation after signup (via `ensure_profile`).
- Idempotent: a second call in the same week updates the run's `granted_count` but issues **no** new credits.

```sql
create or replace function grant_weekly_allowance()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_week  date := date_trunc('week', now())::date;
  v_amt   int  := current_setting('app.credit_weekly_starter_allowance', true)::int;
  v_grant int := 0;
begin
  insert into weekly_allowance_runs (period_start, granted_count, ran_at)
  values (v_week, 0, now())
  on conflict (period_start) do nothing;

  if exists (select 1 from weekly_allowance_runs
              where period_start = v_week and granted_count > 0) then
    return 0;   -- already ran this week
  end if;

  insert into credit_ledger (user_id, delta, kind, status, available_at, note)
  select id, v_amt, 'weekly_allowance', 'available', now(), 'Weekly starter allowance'
    from profiles
  returning 1 into v_grant;
  v_grant := (select count(*) from credit_ledger
               where kind='weekly_allowance' and available_at >= date_trunc('week', now()));

  update weekly_allowance_runs set granted_count = v_grant, ran_at = now()
   where period_start = v_week;

  return v_grant;
end $$;
```

Triggered by:

- A **pg_cron** schedule if the trimmed prod stack includes it (T10 checks), else
- A **Coolify scheduled task** hitting a service-role endpoint that calls this RPC (T10), else
- The `/api/cron/weekly-allowance` route guarded by a `CRON_SECRET` header, invoked by Coolify Scheduler.

The RPC itself is idempotent regardless of trigger, so the choice of scheduler is a deployment detail, not a correctness one.

### 5.4 Hold window and the sweeper

Earning flow:

```
submit_feedback (passes quality gate)
   └─► evaluate_feedback_eligibility  ── eligible?  ──► credit_ledger { status: 'held', available_at: now()+HOLD }
                                                    └─ ineligible ──► no credit, reason recorded
                                          │
                            (HOLD hours pass, or moderation clears)
                                          ▼
                              release_held_credits()  ──►  status 'held' ──► 'available'
```

```sql
create or replace function release_held_credits()
returns int language plpgsql security definer set search_path = public as $$
declare v_released int;
begin
  -- Never release a credit whose feedback was reported or removed.
  update credit_ledger cl
     set status = 'available'
   where cl.status = 'held'
     and cl.kind = 'feedback_earned'
     and cl.available_at <= now()
     and not exists (
       select 1 from feedback fb
        where fb.id = cl.feedback_id
          and (fb.removed_at is not null or fb.eligibility = 'reversed'))
     and not exists (
       select 1 from moderation_reports mr
        where mr.target_type = 'feedback' and mr.target_id = cl.feedback_id
          and mr.state <> 'dismissed');

  get diagnostics v_released = row_count;

  update feedback set eligibility = 'eligible'
   where eligibility = 'held' and hold_until <= now();

  return v_released;
end $$;
```

A scheduled `credits:release-held` script calls this hourly (T10). Releasing early is safe and idempotent; the sweeper is the mechanism, not a source of truth.

### 5.5 Reversal on abuse

When feedback is removed for abuse, any credit it produced is reversed with a paired ledger entry. Reversals never delete rows.

```sql
create or replace function reverse_credit_for_feedback(p_feedback_id uuid, p_note text)
returns int language plpgsql security definer set search_path = public as $$
declare v_reversed int := 0;
begin
  -- Reverse any earned (held or available) credit for this feedback.
  with reversed as (
    update credit_ledger cl
       set status = 'reversed'
     where cl.feedback_id = p_feedback_id
       and cl.kind = 'feedback_earned'
       and cl.status in ('held','available')
    returning cl.id, cl.user_id, cl.delta
  )
  insert into credit_ledger (user_id, delta, kind, status, feedback_id, note, reverses_id)
  select user_id, -delta, 'hold_reversal', 'available', p_feedback_id,
         coalesce(p_note,'Credit reversed: feedback removed for abuse'), id
    from reversed;

  get diagnostics v_reversed = row_count;

  update feedback set eligibility = 'reversed' where id = p_feedback_id;
  return v_reversed;
end $$;
```

The reverse entry is itself `delta = -original`, so balances stay correct while the original row remains visible in history for audit. This runs when an admin resolves a report as abuse (T09), keeping the "reverse them if feedback is removed for abuse" safeguard intact.

### 5.6 Admin credit operations

Three operations, all admin-only, all writing `moderation_actions`:

| Operation                                           | Effect                                                 | Notes                                                                          |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `admin_grant_credit(p_user_id, p_amount, p_note)`   | Adds a positive `admin_grant` row (status `available`) | Onboarding grants, good-faith fixes                                            |
| `admin_reverse_credit(p_user_id, p_amount, p_note)` | Adds a negative `admin_reversal` row                   | Abuse handling; never touches `submission_spend` rows retroactively            |
| `admin_cap_credit(p_user_id, p_max, p_note)`        | Sets a per-user effective ceiling                      | Caps _future_ earnings/submissions at a max; does not claw back existing spend |

```sql
create or replace function admin_cap_credit(p_user_id uuid, p_max int, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'Admin only' using errcode='insufficient_privilege';
  end if;
  insert into moderation_actions (actor_id, action, target_type, target_id, meta)
  values (auth.uid(), 'credit_cap_set', 'user', p_user_id,
          jsonb_build_object('max', p_max, 'note', p_note));
  -- Cap enforced inside evaluate_feedback_eligibility and create_content_entry
  -- by reading the latest moderation_actions 'credit_cap_set' row.
end $$;
```

> Caps are implemented by reading the latest `credit_cap_set` action at decision time, so a cap is auditable and reversible without rewriting history.

### 5.7 Credit UI + copy guard

Components:

- `CreditBalanceCard` — `available`, `held (pending review)`, `submissionCost`, and a one-line explanation of how credits are earned
- `CreditHistoryList` — kind, amount, status, reason, timestamp from `get_credit_summary().history`
- `SubmissionGuard` — disables the submit button when `available < submissionCost`, showing "You need 1 Credit to publish. Earn one by leaving feedback on someone's content."

**Naming/copy guard (prevents the conflation the brief warns about):**

- ESLint `no-restricted-syntax` rule banning the identifiers `points`, `point`, and `pts` in credit-related UI strings.
- A unit test that scans every `t()` / copy string for forbidden patterns.
- Copy always says **"Credits"** for the spendable system and **"Reputation"** for the quality signal. Never "points," never "your points balance is 3, spend 1 to publish."
- `score` is **not** on the banned list, because it is a legitimate domain term elsewhere: the ranking score (T07) and the 1–10 rating score (T06) are both real and neither is a credit. The rule targets naming the _credit balance_ as points — not the word `score` everywhere.

### 5.8 Guard: no credit for external actions

The brief forbids credits for views/likes/follows/shares/comments/votes/viewing time. This is structurally guaranteed: the **only** function that inserts a `feedback_earned` credit is `evaluate_feedback_eligibility` (T02), and the only inputs to it are the feedback quality gate + caps. No function accepts a platform engagement event as a credit input. A CI test greps for any `kind='feedback_earned'` insert outside that function.

---

## 6. Files to create

| Path                                                    | Purpose                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `supabase/migrations/0015_credit_summary.sql`           | `get_credit_summary`, balance helpers, `admin_cap_credit` |
| `supabase/migrations/0016_credit_reversal.sql`          | `reverse_credit_for_feedback`                             |
| `apps/web/src/components/credits/CreditBalanceCard.tsx` | Balance display                                           |
| `apps/web/src/components/credits/CreditHistoryList.tsx` | Transaction history                                       |
| `apps/web/src/components/credits/SubmissionGuard.tsx`   | Submit affordability guard                                |
| `apps/web/src/components/credits/CreditExplainer.tsx`   | "How do I earn Credits?" copy                             |
| `apps/web/src/app/settings/credits/page.tsx`            | Credits dashboard (private)                               |
| `apps/web/src/app/api/cron/weekly-allowance/route.ts`   | `CRON_SECRET`-guarded allowance trigger                   |
| `apps/web/src/app/api/cron/release-held/route.ts`       | `CRON_SECRET`-guarded sweeper trigger                     |
| `scripts/release-held-credits.ts`                       | One-shot sweeper for CLI/CI                               |
| `packages/domain/src/credits.ts`                        | Credit types, formatting, copy constants                  |
| `packages/domain/src/__tests__/copy-guard.test.ts`      | Forbidden-term lint for credits copy                      |
| `supabase/tests/007_credit_economy.sql`                 | pgTAP: caps, holds, reversals, privacy                    |
| `apps/web/src/app/api/admin/credits/route.ts`           | Admin grant/reverse/cap (service-role)                    |
| `tests/e2e/credits.spec.ts`                             | Playwright: earn → submit → balance changes               |

---

## 7. Implementation steps

- [ ] Migration `0015`: `get_credit_summary()` (private), balance views, `admin_cap_credit()`
- [ ] Migration `0016`: `reverse_credit_for_feedback()` with paired reversal entries
- [ ] Wire `evaluate_feedback_eligibility` invocation into the feedback creation server action (credit side; UI in T09)
- [ ] Build `CreditBalanceCard`, `CreditHistoryList`, `CreditExplainer`
- [ ] Build `/settings/credits` (private dashboard)
- [ ] Add `SubmissionGuard` to `/submit` (T04)
- [ ] Build the two cron routes with `CRON_SECRET` verification
- [ ] Write `scripts/release-held-credits.ts` and `scripts/grant-weekly-allowance.ts`
- [ ] Configure the weekly allowance trigger (pg_cron if available, else Coolify scheduler — T10)
- [ ] Build admin credit operations route handlers (service-role + admin check)
- [ ] Wire `reverse_credit_for_feedback` into the moderation resolve flow (stub; UI in T09)
- [ ] Add the copy-guard lint banning `points`/`point`/`pts` in credit-related UI strings
- [ ] Write pgTAP suite `007_credit_economy.sql`
- [ ] Write the Playwright credits spec
- [ ] Grep-test: no `feedback_earned` insert outside the eligibility function; no reputation→credit path

---

## 8. Acceptance criteria

- [ ] `get_credit_summary` returns `available`, `held`, `total`, `submissionCost`, and ≤50 history rows
- [ ] A member reading another member's balance raises "Credit balance is private"
- [ ] `admin_cap_credit` is admin-only and auditable in `moderation_actions`
- [ ] `grant_weekly_allowance()` grants to all active members and is idempotent within a week (second call grants 0)
- [ ] A newly-signed-up member receives the starter allowance on first run after signup
- [ ] Eligible feedback places a **held** credit; balance does not include it until released
- [ ] `release_held_credits()` moves `held` → `available` past `available_at`, and skips feedback that was reported/removed
- [ ] `reverse_credit_for_feedback` inserts a paired negative row and sets `eligibility='reversed'`; history still shows the original
- [ ] A credit cap stops new earning/submission beyond the max without clawing back prior spend
- [ ] Submission is blocked when `available < submissionCost` with an explanatory message
- [ ] No credit is ever inserted from a platform engagement event (grep test)
- [ ] UI never labels credits "points"/"pts"; copy-guard test passes (note: `score` is allowed, used by ranking in T07 and ratings in T06)
- [ ] Credits and Reputation components are structurally incompatible in TypeScript (cannot cross-pass)

---

## 9. Tests

- **pgTAP**: balance privacy (self vs other vs admin), weekly-allowance idempotency, starter-on-signup, per-day and per-creator caps, hold window, sweeper skip-on-reported, reversal pairing, cap enforcement, "no credit without eligible feedback"
- **Unit**: `credits.ts` formatting (negative balances, held rendering); copy-guard forbidden-term scan
- **Integration**: earn credit via `submit_feedback` → balance shows held → release → balance shows available → submit → balance decrements, ledger delta exactly `-1`
- **Type test**: `CreditBalance` is not assignable to `ReputationSummary` (compile-time check)
- **E2E (Playwright)**: member A submits feedback on member B's entry, sees +1 held, waits for release, publishes an entry, balance drops

---

## 10. Verification commands

```bash
supabase test db --file supabase/tests/007_credit_economy.sql
pnpm credits:release-held          # script alias for the sweeper
psql "$DATABASE_URL" -c "select kind, status, count(*), sum(delta) from credit_ledger group by 1,2 order by 1,2;"
psql "$DATABASE_URL" -c "select u.handle, sum(cl.delta) filter (where cl.status='available') as avail, sum(cl.delta) filter (where cl.status='held') as held from credit_ledger cl join profiles u on u.id=cl.user_id group by 1 order by 1 limit 10;"
psql "$DATABASE_URL" -c "select period_start, granted_count, ran_at from weekly_allowance_runs order by 1 desc;"
psql "$DATABASE_URL" -c "select feedback_id, count(*) from credit_ledger where kind='feedback_earned' group by 1 having count(*) > 1;"  -- must return 0 rows
```

---

## 11. Risks & mitigations

| Risk                                                     | Mitigation                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Credit farming via mass feedback across many creators    | Per-day **and** per-creator caps (T02), one feedback per entry, review window, weekly allowance ceiling |
| Concurrency lets a member overspend or double-earn       | `pg_advisory_xact_lock` in `create_content_entry`; `for update` locks in eligibility and sweeper        |
| Weekly allowance fires twice on deploy                   | `weekly_allowance_runs` period key + `on conflict do nothing` guard                                     |
| Held credits confuse members ("where did my credit go?") | `held` shown separately with "pending review" label and its own explanation                             |
| Reputation and credits blur in copy over time            | ESLint ban + copy-guard test + structurally incompatible TS types                                       |
| An admin cap is mistaken for a clawback                  | Cap applies to future activity only; explicitly labeled "limits future earning"                         |
| A credit reversal is mistaken for a deletion             | History retains the original row with a paired reversal; nothing is ever deleted                        |

---

## 12. Definition of done

Credits are earned only through qualifying peer feedback (plus weekly allowance and admin grants), are held briefly for review, are capped against farming, are private to their owner, and are structurally incapable of being confused with or converted from Reputation.
