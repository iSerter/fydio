# Data model

The schema in `supabase/migrations/` is the enforcement layer for the product brief.
Where the brief states a rule — five profile hashtags, exactly three per entry, one
Credit per submission, Reputation that cannot be spent — Postgres holds it, and the
pgTAP suites in `supabase/tests/` prove it.

> **Status:** stub. Expanded in T10, once T03–T09 have built against it.

## The central decision: two ledgers, two enums

Fydio has two community signals and the brief is explicit that they are not
interchangeable:

|                         | Earned by                            | Changes                   | Spendable |
| ----------------------- | ------------------------------------ | ------------------------- | --------- |
| **Fydio Credits**       | Eligible peer feedback               | Contributions to the feed | **Yes**   |
| **Feedback Reputation** | Creators rating a feedback item 1–10 | A quality signal only     | **No**    |

That separation is structural rather than conventional:

- `credit_kind` and `reputation_kind` are **separate Postgres enum types**. There is no
  shared `kind` column, so no SQL statement can write a credit into a reputation row or
  read a rating as spendable.
- `credit_ledger` has `status` (`held` / `available` / `spent` / `reversed`).
  `reputation_ledger` has **no status column at all** — it is strictly append-only, with
  corrections expressed as reversing pairs.
- The submission path reads `credit_ledger` and nothing else. `003_reputation.sql`
  asserts this directly by inspecting `pg_proc` for any `credit_ledger` reference in a
  credit-awarding function, so the guarantee survives a well-meaning future edit.

The headline test is the negative one: a member with **500 reputation and 0 Credits
still cannot submit**. If reputation ever became spendable, that test fails.

## Tables

| Table                | Purpose                      | Notes                                                           |
| -------------------- | ---------------------------- | --------------------------------------------------------------- |
| `profiles`           | Public member identity       | `id` references `auth.users`; reputation aggregates are derived |
| `invites`            | Invite-only gate             | `token_hash`, never the token                                   |
| `hashtags`           | Global tag vocabulary        | `citext` slugs, no leading `#`                                  |
| `profile_hashtags`   | ≤5 per profile               | Deferred constraint trigger enforces the cap                    |
| `profile_links`      | Connected public handles     | Never used for authentication                                   |
| `friendships`        | Mutual connections           | Generated `pair_key` makes one row per pair                     |
| `content_entries`    | Submitted content            | Exactly 3 hashtags; `url_hash` for duplicate detection          |
| `content_hashtags`   | The entry's three tags       | Deferred constraint trigger enforces exactly 3                  |
| `feedback`           | Optional critique            | Body 10–4000 chars, ≤3 images                                   |
| `feedback_ratings`   | 1–10, rated once             | Unique per `feedback_id`                                        |
| `credit_ledger`      | **Spendable** Credits        | See the balance formula below                                   |
| `reputation_ledger`  | **Non-spendable** reputation | Append-only, no status column                                   |
| `feed_impressions`   | Rank audit + opened state    | `mark_entry_opened()` writes here                               |
| `feed_signals`       | More/less/hide tuning        | Affects Fydio's ranking only                                    |
| `mutes`              | Muted creators               | A preference, not a block                                       |
| `outbound_clicks`    | Open events                  | Also marks the entry opened, atomically                         |
| `duration_events`    | Opt-in coarse bands          | **Private to the member**; never rewarded                       |
| `moderation_reports` | User reports                 | One open report per member per target                           |
| `moderation_actions` | Immutable audit trail        | Append-only; no member read policy at all                       |

## The credit balance

```
balance = sum(delta) WHERE status IN ('available', 'spent')
```

Each status contributes deliberately:

- `held` → nothing. Pending its review window, so an abusive item cannot be spent
  before it can be reversed.
- `available` → `delta`. A grant, spendable.
- `spent` → `delta`. **This is what a submission subtracts.**
- `reversed` → nothing. The movement it recorded was undone.

`spent` has to be inside the sum. If spends were recorded with a status the balance
ignored, every submission would be free while every individual statement looked
correct — which is exactly the bug the T02 review caught in the original spec.

A reversal flips the original row to `reversed` and inserts a paired audit row that is
_also_ `reversed`, so the balance falls by exactly the amount, once. Doing it the other
way round would subtract twice.

## Spending a Credit

`create_content_entry()` is the most important function in the schema:

1. Validate three **distinct** hashtags, all existing in the pool.
2. Check blocked accounts and the new-member submission rate cap.
3. Reject a duplicate URL per author.
4. `pg_advisory_xact_lock` — **before** the balance read, not after.
5. Read the balance; refuse if it is below the cost.
6. Insert the spend (`-1`, `spent`) and the entry in one transaction.

Step 4 is a correctness requirement. Two rapid clicks produce two overlapping
transactions; without the lock both read the same balance, both decide they can
afford it, and both insert. The lock serialises submissions per user and is
transaction-scoped, so it releases itself on commit or rollback with no cleanup path.
`rpc.integration.test.ts` proves it with two genuinely concurrent HTTP calls against a
balance of one.

## Row level security

RLS is enabled on **every** table, with `force` on `credit_ledger` and
`duration_events`. Default-deny comes from a role having zero policies, not from
`using (false)` written everywhere.

Two boundaries are worth stating:

- **Credit balances are private.** A member can read only their own ledger rows.
  `get_credit_balance()` is the sanctioned accessor and re-checks self-or-admin
  internally, because it is SECURITY DEFINER and bypasses the policy.
- **Duration telemetry is private** to the member who produced it, admin included.
  There is deliberately no admin read policy — the brief treats it as the viewer's own
  history.

Recursion is avoided with `SECURITY DEFINER stable` helpers (`is_admin`,
`can_view_entry`): a policy on `feedback` needs `content_entries`, whose policy needs
`profiles`, and Postgres detects that cycle.

## Feedback eligibility

A Credit is earned here, and only here. `evaluate_feedback_eligibility()` is idempotent
and applies, in order:

1. Removed or reported → `reversed`.
2. Per-day cap → `ineligible` / `daily_cap_reached`.
3. Per-creator cap → `ineligible` / `per_creator_cap_reached`.
4. Otherwise → a **held** Credit with a review window.

The quality gate affects _eligibility_, not submission: a short note is stored and
simply earns nothing, because refusing to store it would be worse for the member than
storing something worthless.

## Reputation

`rate_feedback()` is entry-owner-only, rates once per item, and writes **only** to the
reputation ledger — there is no `credit_ledger` reference anywhere in that path.
Revisions inside the window write a reversing pair rather than editing the score, so a
member's history of giving feedback is never silently rewritten.

## Verification

```bash
pnpm db:reset      # migrations + seed, zero constraint violations
pnpm db:test       # 83 pgTAP assertions across four suites
pnpm db:types      # regenerate the Database type
```

`rank_feed()` currently implements the deterministic baseline from the brief
(tag match + friend affinity + freshness + feedback need), mirroring
`scoreCandidate` in `@fydio/domain`. Diversity adjustment and cursor pagination land in
T07.
