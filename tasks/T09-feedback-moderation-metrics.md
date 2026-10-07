# T09 — Feedback Surfaces, Moderation Console & Success Metrics

**Status:** completed
**Depends on:** T05, T06, T07, T08
**Blocks:** T10
**Brief reference:** §7 Feedback, §8 Reputation, §9 Credit safeguards, §Include "Optional feedback with text and up to three images", "Creator feedback inbox and 1–10 feedback ratings", "Admin controls for users, content, tags, reports, and moderation", §Success metrics.

---

## 1. Goal

Close the product loop with the surfaces members and admins actually touch:

- **Feedback composer** (text + up to 3 images + structured tags), with edit/remove rules
- **Creator feedback inbox** and the 1–10 rating UI
- **Feedback giver's portfolio** (their own rated feedback)
- **Admin console**: users, content, tags, reports, moderation, credit operations
- **Success-metrics dashboard** built only from Fydio-internal signals

After T09 the full cycle works end to end: submit → feed → open → return → feedback → rating → reputation, with moderation over the top.

---

## 2. Why this position in the plan

Feedback is the payoff of the whole loop; it needs credits (T05) to reward it, reputation (T06) to score it, opened state (T08) to gate it, and feed (T07) to surface entries. The admin console and metrics layer on top of all four. T10 then only adds the extension and deployment.

---

## 3. Scope

### In scope

- Feedback composer: text (10–4000 chars), up to 3 images, structured tags, edit/remove within grace
- Storage bucket `feedback-images` + RLS policies
- Creator inbox: all feedback received, per entry and aggregated on the profile dashboard
- Rating UI: 1–10, rate-once, revision within window, rating state on already-rated items
- Feedback giver portfolio: list of their feedback with rating received (private to them)
- Report flow: report a user / entry / feedback / hashtag
- Admin console: user list + role management, content moderation (hide/remove), tag management, report queue with resolve actions, credit grant/reverse/cap (T05)
- Metrics dashboard: the 9 success metrics, Fydio-internal only
- Copy separating Credits / Reputation consistently

### Explicitly out of scope

- Extension (T10)
- Production deploy (T10)
- Automated content moderation / AI classification — manual admin queue only
- Public leaderboards, social sharing, notifications beyond in-app badges
- Any external-platform engagement metrics

---

## 4. Deliverables

1. `/c/[id]` feedback section + composer (entry page)
2. `/inbox` creator feedback inbox with rating controls
3. `/dashboard` creator dashboard (feedback received, ratings, open rates)
4. `/u/[handle]` feedback portfolio section (public rated feedback; private portfolio for own)
5. Report dialog on entries/feedback/profiles
6. `/admin/*`: users, content, tags, reports, credits
7. `/admin/metrics` success-metrics dashboard
8. Tests: composer validation, rate-once UI, moderation reversals, metric correctness

---

## 5. Technical design

### 5.1 Feedback composer

Feedback is **voluntary** and attaches to an entry the member has opened.

```ts
// packages/domain/src/feedback.ts
export const feedbackTags = [
  'hook',
  'clarity',
  'editing',
  'storytelling',
  'thumbnail',
  'cta',
  'audience_fit',
] as const

export const submitFeedbackSchema = z.object({
  entryId: z.string().uuid(),
  body: z.string().min(10, 'Write at least 10 characters').max(4000),
  tags: z.array(z.enum(feedbackTags)).max(7).default([]),
  imagePaths: z.array(z.string()).max(3, 'Up to 3 images').default([]),
})

// Quality gate mirrors the SQL: enough text OR at least one image.
export function meetsQualityGate(body: string, imageCount: number, minChars: number) {
  return body.trim().length >= minChars || imageCount > 0
}
```

Composer UX:

- Textarea with a live character counter
- Up to 3 image slots with drag-drop; each validated (JPEG/PNG/WebP, ≤5 MB, re-encoded to ≤400 KB)
- Optional structured tag chips (hook, clarity, editing, storytelling, thumbnail, CTA, audience fit)
- **Optional throughout** — the whole form is skippable; closing it is a normal action
- On submit: `submit_feedback` RPC (T02) → eligibility evaluated (T05) → toast confirming "Feedback shared — +1 Credit pending review" (or "Feedback shared") depending on eligibility, never promising Credits unconditionally

The composer clearly separates the two systems in its copy:

> "Helpful feedback earns a Fydio Credit (pending review) and builds your Reputation when the creator rates it."

### 5.2 Feedback images

- Bucket `feedback-images`, **public read** (a creator must see the images), owner-scoped writes
- Path: `{author_id}/{feedback_or_temp_id}/{n}.webp`
- Re-encode via `sharp` to WebP ≤400 KB, strip EXIF (privacy)
- Deletion: when feedback is edited, replaced images are deleted; when removed, all are deleted

### 5.3 Edit / remove rules

"The feedback giver can edit or remove their feedback until it is rated or after a short grace period."

```sql
create or replace function can_edit_feedback(p_feedback_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select f.author_id = auth.uid()
     and f.removed_at is null
     and not exists (select 1 from feedback_ratings r where r.feedback_id = f.id)
     and f.created_at > now() - make_interval(
           hours => current_setting('app.feedback_edit_grace_hours', true)::int)
  from feedback f where f.id = p_feedback_id;
$$;
```

Enforced two ways:

- **Editing text after a credit was earned** resets eligibility to `pending` and (if a held/available credit was issued) triggers a reversal, so editing cannot launder a credited item.
- **After rating or grace expiry**, edit is blocked; removal remains allowed (soft, audited).

### 5.4 Creator feedback inbox

`/inbox` lists feedback received on all of the creator's entries:

| Column                        | Detail                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| Entry thumbnail + title       | Click-through to `/c/[id]`                                      |
| Feedback author               | Avatar, display name, Reputation (public)                       |
| Feedback body + tags + images | Full content                                                    |
| Rating state                  | Unrated → 1–10 input; Rated → stars + "revise within 24h"       |
| Credit note                   | Whether this feedback earned the giver a Credit (informational) |

Rating interaction (optimistic, `rate_feedback` RPC):

- 1–10 selector with a keyboard-accessible slider
- Confirmation inline (no modal round-trip)
- After rating, the item shows the score and a revise affordance if within the window
- Errors surface as friendly messages ("This feedback has already been rated")

### 5.5 Feedback giver portfolio

A member's own `/dashboard/feedback` shows the feedback they wrote and the ratings received (private to them). This is the "personal feedback-quality portfolio" concept from the brief's future list, shipped early because it makes Reputation legible to the person earning it.

It shows:

- Each feedback item, its entry, and the rating received (or "not yet rated")
- Reputation total, rated count, average (from T06)
- A note: "Reputation is private signal, not a leaderboard — it can't be spent."

### 5.6 Report flow

Report dialog available on entries, feedback, profiles, and hashtags:

| Target        | Reasons                                                    |
| ------------- | ---------------------------------------------------------- |
| Content entry | Spam, off-topic, broken/invalid link, inappropriate, other |
| Feedback      | Abusive, unhelpful/spam, other                             |
| User          | Harassment, spam, impersonation, other                     |
| Hashtag       | Inappropriate, spam, other                                 |

Reports land in `moderation_reports` and surface in the admin queue. Reporting immediately marks the target for eligibility re-check (T05) so credits from reported feedback are not released.

### 5.7 Admin console

| Route            | Capabilities                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/users`   | List/search members, view profiles, grant/revoke `admin`, view credit balance (admin-only read), suspend                                                                                                   |
| `/admin/content` | List entries, view previews, hide (`status='hidden'`) or soft-remove; removing reverses any credit spent on it? (No — spend is non-refundable per brief; admin may grant a compensating credit separately) |
| `/admin/tags`    | List/create/rename tags, mark official, merge duplicates                                                                                                                                                   |
| `/admin/reports` | Queue of `moderation_reports`; resolve with action: dismiss, hide target, remove feedback, reverse credit, reverse reputation, suspend user                                                                |
| `/admin/credits` | Grant / reverse / cap (T05)                                                                                                                                                                                |
| `/admin/metrics` | Success metrics dashboard                                                                                                                                                                                  |

All admin actions are service-role, role-checked, and write `moderation_actions`. Resolving a report as "abusive feedback" chains:

1. `feedback.removed_at = now()`
2. `reverse_credit_for_feedback` (T05) — reverses any held/available credit
3. `reverse_reputation_for_feedback` (T06) — removes the score from reputation
4. `moderation_actions` audit row

### 5.8 Success metrics dashboard

Only Fydio-internal signals — explicitly **not** external likes, views, followers, shares, or watch time:

| Metric                                   | Source                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Weekly active members                    | `outbound_clicks` + `feed_impressions` distinct viewers per week   |
| Content submissions per active member    | `content_entries` / distinct active submitters, per week           |
| Feed open rate                           | `opened` impressions / total impressions                           |
| Feedback items per opened entry          | `feedback` / `outbound_clicks` (distinct entry+user)               |
| Credits earned through eligible feedback | `credit_ledger` where `kind='feedback_earned'`                     |
| Credits spent on submissions             | `credit_ledger` where `kind='submission_spend'`                    |
| Percentage of feedback rated by creators | `feedback_ratings` / `feedback`                                    |
| Average rated feedback score             | `avg(score)` from `feedback_ratings`                               |
| 7- and 28-day retention                  | cohort of members by `profiles.created_at`, activity within window |
| Distribution fairness                    | % of active creators receiving ≥1 open or feedback                 |

A single SQL view `weekly_engagement_dashboard` (from T02) powers most of these; the dashboard renders simple trend cards and tables. No charts library needed for MVP — keep it dependency-light.

---

## 6. Files to create

| Path                                                       | Purpose                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `supabase/migrations/0027_feedback_lifecycle.sql`          | `can_edit_feedback`, edit/remove RPCs with eligibility reset |
| `supabase/migrations/0028_reporting.sql`                   | `report_content` RPC                                         |
| `supabase/migrations/0029_metrics_views.sql`               | `weekly_engagement_dashboard`, fairness + retention views    |
| `apps/web/src/components/feedback/FeedbackComposer.tsx`    | Composer form                                                |
| `apps/web/src/components/feedback/FeedbackCard.tsx`        | One feedback item                                            |
| `apps/web/src/components/feedback/ImageSlots.tsx`          | Up-to-3 image slots                                          |
| `apps/web/src/components/feedback/TagPicker.tsx`           | Structured tag chips                                         |
| `apps/web/src/components/feedback/RatingInput.tsx`         | 1–10 control + revise                                        |
| `apps/web/src/components/feedback/ReportDialog.tsx`        | Report flow                                                  |
| `apps/web/src/app/inbox/page.tsx`                          | Creator inbox                                                |
| `apps/web/src/app/dashboard/page.tsx`                      | Creator dashboard                                            |
| `apps/web/src/app/dashboard/feedback/page.tsx`             | Feedback portfolio                                           |
| `apps/web/src/app/admin/users/page.tsx`                    | Admin users                                                  |
| `apps/web/src/app/admin/content/page.tsx`                  | Admin content                                                |
| `apps/web/src/app/admin/tags/page.tsx`                     | Admin tags                                                   |
| `apps/web/src/app/admin/reports/page.tsx`                  | Report queue                                                 |
| `apps/web/src/app/admin/credits/page.tsx`                  | Credit ops                                                   |
| `apps/web/src/app/admin/metrics/page.tsx`                  | Metrics dashboard                                            |
| `apps/web/src/app/api/reports/route.ts`                    | Report submission                                            |
| `apps/web/src/app/api/admin/reports/[id]/resolve/route.ts` | Resolve + cascade                                            |
| `apps/web/src/app/api/feedback/cover/route.ts`             | Feedback image upload                                        |
| `packages/domain/src/feedback.ts`                          | zod schema, tags, quality gate                               |
| `supabase/tests/011_feedback_lifecycle.sql`                | pgTAP: edit/remove/eligibility reset                         |
| `tests/e2e/feedback-loop.spec.ts`                          | Playwright: full loop                                        |
| `docs/metrics/success-metrics.md`                          | Metric definitions + SQL sources                             |

---

## 7. Implementation steps

- [ ] Migration `0027`: `can_edit_feedback`, `update_feedback` (resets eligibility + reverses credit if earned), `remove_feedback`
- [ ] Migration `0028`: `report_content` RPC with target/reason validation
- [ ] Migration `0029`: metrics views (`weekly_engagement_dashboard`, retention, fairness)
- [ ] Create `feedback-images` bucket + RLS policies
- [ ] Build `FeedbackComposer` (text + 3 images + tags), upload route with `sharp` re-encode + EXIF strip
- [ ] Wire composer into `/c/[id]` and `/opened/[token]` (T08)
- [ ] Surface eligibility outcome in the submit toast (earned / pending / ineligible)
- [ ] Build `FeedbackCard` with edit/remove honoring the grace window
- [ ] Build `/inbox` creator inbox with `RatingInput` (1–10, rate-once, revise)
- [ ] Build `/dashboard` (feedback received, open rates, rating breakdown)
- [ ] Build `/dashboard/feedback` portfolio (own feedback + ratings received)
- [ ] Build `ReportDialog` and wire to `/api/reports`
- [ ] Build admin console: users, content, tags, reports, credits (T05 ops)
- [ ] Build report resolve cascade: remove → reverse credit → reverse reputation → audit
- [ ] Build `/admin/metrics` dashboard from the metrics views
- [ ] Ensure the copy-guard (T05) passes across all new UI strings (no "points" for either system)
- [ ] Write pgTAP suite `011_feedback_lifecycle.sql`
- [ ] Write `docs/metrics/success-metrics.md`
- [ ] Write the Playwright full-loop spec (submit → feed → open → return → feedback → rate → check reputation)

---

## 8. Acceptance criteria

- [ ] Feedback can be left on any entry the member has opened, and rejected otherwise
- [ ] Self-feedback is rejected with a clear message
- [ ] Up to 3 images attach; a 4th is blocked in UI and by the DB
- [ ] Feedback is optional — the entry page renders fine with the composer skipped
- [ ] Submitting feedback shows whether it earned a Credit (pending review) or did not qualify
- [ ] The creator sees all feedback for their entries in `/inbox`
- [ ] Rating is 1–10, rate-once, owner-only; a second attempt is blocked in UI and DB
- [ ] A rating updates the giver's Reputation immediately and does **not** change any Credit
- [ ] Ratings can be revised within the window and net out correctly
- [ ] Feedback can be edited before rating/grace, and editing a credited item reverses the Credit
- [ ] Feedback can be removed within grace; removal triggers credit + reputation reversal
- [ ] Members can report entries, feedback, profiles, and hashtags
- [ ] Admin can hide/remove content, manage tags, and resolve reports with a full audit trail
- [ ] Resolving a report as abusive reverses both the Credit and the Reputation
- [ ] Non-admins cannot reach `/admin/*` or its APIs
- [ ] The metrics dashboard shows all 10 success metrics using only Fydio-internal data
- [ ] No metric is sourced from external likes, views, followers, shares, or watch time
- [ ] Copy guard: no UI string calls either system "points"

---

## 9. Tests

- **pgTAP**: `can_edit_feedback` boundaries (rated blocks edit, grace expiry blocks edit, self-can't-edit); edit resets eligibility; removal reverses credit; report creation.
- **Unit**: `meetsQualityGate` boundary (min chars, image-present); tag schema; rating range.
- **Integration**: full RPC loop — `submit_feedback` → eligibility → credit held; `rate_feedback` → reputation up; `revise_rating` → net correct; `remove_feedback` → both reversed.
- **E2E (Playwright, the acceptance loop)**: A submits an entry; B sees it in feed with a reason; B opens it (new tab); B returns; B leaves feedback with an image; A sees it in inbox and rates 8; B's reputation reflects +8; B's credit is held then released; B submits their own entry; admin hides it.
- **Admin (integration)**: non-admin blocked; admin resolve cascades correctly.

---

## 10. Verification commands

```bash
supabase test db --file supabase/tests/011_feedback_lifecycle.sql
pnpm --filter @fydio/web test -- feedback

psql "$DATABASE_URL" -c "select count(*) filter (where eligibility='eligible') as eligible, count(*) filter (where eligibility='held') as held, count(*) filter (where eligibility='ineligible') as ineligible, count(*) filter (where eligibility='reversed') as reversed from feedback;"
psql "$DATABASE_URL" -c "select count(*) as ratings, round(avg(score),2) as avg_score from feedback_ratings;"
psql "$DATABASE_URL" -c "select u.handle, u.reputation_total, coalesce(sum(cl.delta) filter (where cl.status in ('available','held')),0) as credits from profiles u left join credit_ledger cl on cl.user_id=u.id group by 1,2 order by 2 desc limit 10;"
psql "$DATABASE_URL" -c "select * from weekly_engagement_dashboard order by week_start desc limit 4;"
psql "$DATABASE_URL" -c "select state, count(*) from moderation_reports group by 1;"
```

---

## 11. Risks & mitigations

| Risk                                                 | Mitigation                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Feedback feels mandatory rather than voluntary       | Composer is skippable and clearly optional; no nagging; submit is one tap or none                                    |
| Credits/reputation conflated in feedback copy        | Explicit two-system copy; copy-guard test; separate components                                                       |
| Rating a low-quality note feels harsh                | 1–10 framed as usefulness; recipients revise within a window                                                         |
| Editing a credited feedback item to game eligibility | Editing resets eligibility and reverses any earned Credit                                                            |
| Report abuse (brigading)                             | Reports require reason + details; admins dismiss unfounded ones; only a resolved-as-abusive report reverses anything |
| Admin console becomes a data dump                    | Paginated, role-scoped views; Credit balances readable by admins but still private to members publicly               |
| Metrics query gets slow                              | Pre-aggregated views + indexes on `(served_at)`, `(clicked_at)`, `(created_at)`; weekly grain keeps rows small       |

---

## 12. Definition of done

The full loop works end to end — submit, discover, open, return, feedback, rating, reputation — with credit safeguards, a moderation console that reverses both signals when abuse is confirmed, and a metrics dashboard built only from Fydio-internal signals, all copy clearly separating Credits from Reputation.
