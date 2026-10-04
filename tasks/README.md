# Fydio — Implementation Tasks

Technical plan for building **Fydio | Curated Feeds** from `fydio-product-brief.md`.

**Stack:** Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 · Supabase (Auth, Postgres, Storage, Edge Functions) · pnpm workspaces + Turborepo · Docker for dev **and** prod · Coolify v4.11 for deployment.

---

## Tasks

| #       | Task                                                                                              | Depends on         | Focus                                                  |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| **T01** | [Monorepo Foundation & Local Supabase Stack](./T01-monorepo-foundation.md)                        | —                  | Workspace, env contract, Docker Supabase stack, CI     |
| **T02** | [Database Schema, Migrations, RLS & Types](./T02-database-schema-rls-types.md)                    | T01                | All tables, RLS, RPCs, seed, pgTAP invariants          |
| **T03** | [Invite-Only Auth, Profiles, Hashtags & Friendships](./T03-auth-profiles-hashtags-friendships.md) | T02                | Invite gate, onboarding, 5-hashtag cap, mutual friends |
| **T04** | [Content Submission, Platform Parsing & Previews](./T04-content-submission-previews.md)           | T02, T03           | URL detection, 3 hashtags, oEmbed + link-card fallback |
| **T05** | [Fydio Credits: Ledger, Eligibility & Safeguards](./T05-credits-ledger-safeguards.md)             | T02                | Weekly allowance, caps, hold window, reversals         |
| **T06** | [Feedback Reputation: Ratings & Reputation Ledger](./T06-reputation-ratings-ledger.md)            | T02                | 1–10 ratings, append-only ledger, non-spendability     |
| **T07** | [Curated Home Feed: Ranking & Tuning](./T07-curated-feed-ranking.md)                              | T02, T03           | Deterministic ranking, transparency, tune signals      |
| **T08** | [Outbound Clicks, Opened State & Duration Telemetry](./T08-outbound-clicks-duration-telemetry.md) | T02, T04, T07      | Click tracking, return tokens, consented coarse bands  |
| **T09** | [Feedback Surfaces, Moderation Console & Metrics](./T09-feedback-moderation-metrics.md)           | T05, T06, T07, T08 | Composer, inbox, ratings, admin, success metrics       |
| **T10** | [Chrome Extension, Docker Prod Build & Coolify Deploy](./T10-extension-coolify-deployment.md)     | T08, T09           | MV3 companion, standalone image, Coolify resources     |
| **T11** | [Limited-Use Invite Links (`/join/{code}`)](./T11-limited-invite-links.md)                       | T03                | Capped shareable codes, atomic use limit, admin minting |

---

## Dependency graph

```
T01 ──► T02 ──┬──► T03 ──┬──► T04 ──┐
              │          │          │
              │          └──► T07 ──┼──► T08 ──┐
              │                     │          │
              ├──────► T05 ─────────┤          ├──► T09 ──► T10
              │                     │          │
              └──────► T06 ─────────┴──────────┘
                         │
                         └──► T11   (optional; nothing waits on it)
```

## Document structure

Each task document contains 12 sections:

1. Goal · 2. Why this position · 3. Scope (in / out) · 4. Deliverables · 5. Technical design · 6. Files to create · 7. Implementation steps · 8. Acceptance criteria · 9. Tests · 10. Verification commands · 11. Risks & mitigations · 12. Definition of done

---

## Non-negotiable product invariants

These are enforced structurally (database constraints, RPCs, RLS, types) rather than in the UI, and each has a test that fails the build if violated:

| Invariant                                                                      | Enforced in                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Credits are spendable; Reputation is **not**                                   | `reputation_ledger` has no `status`/`spent` state; no conversion RPC exists; incompatible TS types; negative test |
| Reputation never changes the Credit amount                                     | `rate_feedback` writes only to `reputation_ledger`                                                                |
| No credits for views, likes, follows, shares, comments, votes, or viewing time | The only `feedback_earned` insert lives inside `evaluate_feedback_eligibility`; CI grep test                      |
| Profile hashtags: 5 is a hard maximum                                          | Deferred constraint trigger + `set_profile_hashtags` RPC + UI counter                                             |
| Content entries: exactly 3 hashtags                                            | Deferred constraint trigger + `create_content_entry`                                                              |
| 1 Credit per submission, debited atomically                                    | `pg_advisory_xact_lock` + balance check in one transaction                                                        |
| Each feedback item rated once; only by the entry owner                         | `feedback_ratings` UNIQUE + owner check                                                                           |
| Credit balances stay private in MVP                                            | RLS own-rows-only + `SECURITY DEFINER` guard                                                                      |
| Duration telemetry is opt-in, coarse, private                                  | Consent-version gate; band-only schema; no raw duration column                                                    |
| Ranking is deterministic and transparent                                       | SQL function mirrored by a TypeScript reference; every card carries a reason                                      |
| No automated platform interaction                                              | No code path performs likes, follows, shares, comments, or votes                                                  |
| Neither system is called "points"                                              | ESLint copy guard + unit test                                                                                     |

## Suggested build order

T01 → T02 unlock everything. T03 and T04 are the fastest path to a demoable loop. T05 and T06 are independent of each other. T07 and T08 build the feed experience. T09 closes the loop with feedback and admin. T10 ships it. T11 is optional and blocks nothing — add it when you want to grow the community in batches rather than one invitation at a time.
