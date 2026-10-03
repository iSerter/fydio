# T06 — Feedback Reputation: Ratings & Reputation Ledger

**Status:** Not started
**Depends on:** T02
**Blocks:** T09
**Brief reference:** §8 Reputation, §7 Feedback, §Include "Creator feedback inbox and 1–10 feedback ratings", "Reputation totals", §principle 2 "Useful feedback over vanity metrics."

---

## 1. Goal

Implement the **quality** signal: creators rate received feedback 1–10, each rating appends to an immutable reputation ledger, profiles surface total / rated count / average, and score-farming protections hold. Reputation is provably **not spendable** anywhere.

After T06 a creator can open an entry's feedback, rate each item, and the feedback giver's public reputation updates accordingly.

---

## 2. Why this position in the plan

Credits (T05) reward _contributing_; reputation rewards _being useful_. They are intentionally decoupled, and reputation is the half that makes feedback quality legible. It follows T02 (schema) and runs parallel to T05, both landing before T09's unified surfaces.

---

## 3. Scope

### In scope

- Rating RPC flow: rate once, owner-only, 1–10, revision window
- Append-only reputation ledger with reversing pairs for revisions/moderation
- Profile reputation aggregates (total, rated count, average) and badge thresholds
- `get_reputation` / `get_rating_summary` read models
- Public "rated feedback" display on profiles (visible to all members)
- Score-farming guards: owner-only, rate-once, no self-rating, revision window, moderation reversal, duplicate-account awareness
- Copy that frames reputation as helpfulness, not popularity; **no public leaderboard** in MVP

### Explicitly out of scope

- Rating UI (rating modal, inbox) — lands in T09
- Reputation affecting credits in any way — **forbidden**, and structurally absent
- Public rankings/leaderboards — explicitly excluded by the brief for MVP
- Badges beyond simple total thresholds (advanced badge art is future scope)

---

## 4. Deliverables

1. `revise_rating` + moderation reversal RPCs with reversing ledger pairs
2. `refresh_profile_reputation` aggregate updater (called on every rating change)
3. `get_reputation(p_user_id)` public read model + badge tier computation
4. Reputation display components (used by profile in T09)
5. Rating policy constants + copy
6. Tests: rate-once, owner-only, non-spendability, revision window, aggregate accuracy, farming guards

---

## 5. Technical design

### 5.1 Rating lifecycle

```
feedback (eligible or ineligible — rating is independent of credit eligibility)
    │
    ├─ entry owner rates 1..10  ──► feedback_ratings (UNIQUE feedback_id)  ──► reputation_ledger +delta
    │
    ├─ within 24h: revise ──────► feedback_ratings.score updated
    │                              reputation_ledger −old (rating_revision)
    │                              reputation_ledger +new (rating_revision)
    │
    └─ moderation removes abuse ─► reputation_ledger −score (moderation_reversal)
                                    aggregates recomputed
```

Key independence: **an entry's owner can rate feedback regardless of whether that feedback earned the giver a Credit.** Credits measure contribution volume under quality gates; reputation measures usefulness as judged by the recipient. Coupling them would let the two systems blur — the exact failure the brief warns about.

### 5.2 Rate-once + owner-only (recap of the T02 core)

```sql
-- Already defined in T02; restated because it is the heart of the anti-farming rule.
create or replace function rate_feedback(p_feedback_id uuid, p_score smallint)
returns feedback_ratings
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_fb feedback; v_owner uuid; v_rating feedback_ratings;
begin
  if p_score < 1 or p_score > 10 then
    raise exception 'Rating must be between 1 and 10' using errcode='check_violation';
  end if;
  select f.*, e.author_id into v_fb, v_owner
    from feedback f join content_entries e on e.id = f.entry_id
   where f.id = p_feedback_id;
  if v_owner <> v_uid then
    raise exception 'Only the content owner can rate feedback on their own entry'
      using errcode='insufficient_privilege';
  end if;
  if v_fb.author_id = v_uid then
    raise exception 'Self-rating is not allowed' using errcode='check_violation';
  end if;
  if exists (select 1 from feedback_ratings where feedback_id = p_feedback_id) then
    raise exception 'This feedback has already been rated' using errcode='unique_violation';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_fb.author_id::text));
  insert into feedback_ratings (feedback_id, entry_owner_id, rater_id, score, source)
  values (p_feedback_id, v_uid, v_uid, p_score, 'creator_rating') returning * into v_rating;

  -- Reputation ONLY. No credit side effect.
  insert into reputation_ledger (user_id, delta, kind, rating_id, feedback_id)
  values (v_fb.author_id, p_score, 'creator_rating', v_rating.id, p_feedback_id);

  perform refresh_profile_reputation(v_fb.author_id);
  return v_rating;
end $$;
```

### 5.3 Revision window with reversing pairs

```sql
create or replace function revise_rating(p_feedback_id uuid, p_score smallint)
returns feedback_ratings
language plpgsql security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_rating  feedback_ratings;
  v_old     smallint;
  v_window  int := current_setting('app.rating_revision_window_hours', true)::int;
begin
  select * into v_rating from feedback_ratings where feedback_id = p_feedback_id for update;
  if v_rating.rater_id <> v_uid then
    raise exception 'Only the original rater can revise' using errcode='insufficient_privilege';
  end if;
  if now() > v_rating.created_at + make_interval(hours => v_window) then
    raise exception 'Revision window has closed' using errcode='check_violation';
  end if;
  if p_score < 1 or p_score > 10 then
    raise exception 'Rating must be between 1 and 10' using errcode='check_violation';
  end if;

  v_old := v_rating.score;

  -- Reverse the old contribution, then add the new one. Append-only ledger.
  insert into reputation_ledger (user_id, delta, kind, rating_id, feedback_id, reverses_id)
  values (v_rating.entry_owner_id, -v_old, 'rating_revision', v_rating.id, p_feedback_id, NULL);

  update feedback_ratings set score = p_score, revised_at = now() where id = v_rating.id returning * into v_rating;

  insert into reputation_ledger (user_id, delta, kind, rating_id, feedback_id)
  select (select author_id from feedback where id = p_feedback_id), p_score, 'rating_revision', v_rating.id, p_feedback_id;

  perform refresh_profile_reputation((select author_id from feedback where id = p_feedback_id));
  return v_rating;
end $$;
```

The ledger therefore always nets out correctly: `sum(delta)` over a feedback giver's rows equals their current reputation, revisions and reversals included.

### 5.4 Moderation reversal

When an admin removes abusive feedback (T09), the reputation it produced is reversed:

```sql
create or replace function reverse_reputation_for_feedback(p_feedback_id uuid, p_note text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_reversed int := 0; v_score smallint; v_giver uuid;
begin
  if (select role from profiles where id = v_uid) <> 'admin' then
    raise exception 'Admin only' using errcode='insufficient_privilege';
  end if;

  select author_id into v_giver from feedback where id = p_feedback_id;
  select score into v_score from feedback_ratings where feedback_id = p_feedback_id;

  if v_score is not null then
    insert into reputation_ledger (user_id, delta, kind, rating_id, feedback_id)
    values (v_giver, -v_score, 'moderation_reversal',
            (select id from feedback_ratings where feedback_id = p_feedback_id), p_feedback_id);

    update feedback_ratings set revised_at = now() where feedback_id = p_feedback_id;
    perform refresh_profile_reputation(v_giver);
    v_reversed := 1;
  end if;

  insert into moderation_actions (actor_id, action, target_type, target_id, meta)
  values (v_uid, 'reputation_reversed', 'feedback', p_feedback_id,
          jsonb_build_object('score_reversed', v_score, 'note', p_note));

  return v_reversed;
end $$;
```

### 5.5 Profile aggregates + badges

```sql
create or replace function refresh_profile_reputation(p_user_id uuid)
returns void language sql security definer set search_path = public as $$
  update profiles p
     set reputation_total = coalesce(r.total, 0),
         rated_feedback_count = coalesce(r.cnt, 0),
         reputation_avg = coalesce(r.avg, 0)
    from (
      select sum(delta) as total, count(*) filter (where delta > 0) as cnt, avg(greatest(delta,0)) as avg
      from reputation_ledger where user_id = p_user_id
    ) r
   where p.id = p_user_id;
$$;
```

Public read model:

```sql
create or replace function get_reputation(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'total',        p.reputation_total,
    'ratedCount',   p.rated_feedback_count,
    'average',      p.reputation_avg,
    'badge',        case
                        when p.reputation_total >= 250 then 'mentor'
                        when p.reputation_total >= 100 then 'trusted'
                        when p.reputation_total >= 25  then 'contributor'
                        else 'new'
                      end
  ) from profiles p where p.id = p_user_id;
$$;
```

> `average` is `avg(greatest(delta,0))` so moderation reversals (negative rows) do not drag a helpful member's average down artificially; `total` still nets reversals out. Documented so the number is not mysterious.

Badge thresholds are configurable via `app.reputation_badge_thresholds` (a JSON setting) rather than hardcoded literals, so the community can tune them without a migration.

### 5.6 Non-spendability (structural guarantee)

Reputation cannot be spent. This is enforced four ways:

1. **Schema**: `reputation_ledger` has no `status` column and no `'spent'` enum value. There is literally no way to mark reputation as spent.
2. **No conversion RPC**: no function reads `reputation_ledger` and writes `credit_ledger`. A CI grep test fails the build if one appears.
3. **Type system**: `ReputationSummary` and `CreditBalance` are structurally incompatible TS types; neither is assignable to the other.
4. **Test**: give a member 500 reputation with 0 credits → `create_content_entry` must still raise `Insufficient Credits`.

### 5.7 Farming guards

| Guard                               | Mechanism                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Only the entry owner rates          | `rate_feedback` owner check                                                      |
| Each feedback rated once            | `feedback_ratings` UNIQUE on `feedback_id`                                       |
| No self-rating                      | explicit check + `enforce_feedback_integrity` trigger (no self-feedback)         |
| Duplicate-account activity blocked  | flagged for admin review (T09); reputation from one account is admin-suspendable |
| Ratings revisable in a short window | `revise_rating` with `rating_revision_window_hours`                              |
| Moderation can remove and reverse   | `reverse_reputation_for_feedback`                                                |
| No public rankings in MVP           | no leaderboard query/view exists; profiles show only the member's own numbers    |
| Reputation is not popularity        | only content-owner ratings count; no "likes received" input exists               |

### 5.8 Reputation copy

Profiles display:

- Reputation total
- Number of rated feedback items
- Average received feedback rating
- Badge at thresholds

Copy frames it as helpfulness:

> "Reputation reflects how useful the community found your feedback. It cannot be spent or transferred."

Never: leaderboards, "top feedback givers," or comparisons across members.

---

## 6. Files to create

| Path                                                         | Purpose                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `supabase/migrations/0017_reputation_aggregates.sql`         | `refresh_profile_reputation`, `get_reputation`, badge thresholds      |
| `supabase/migrations/0018_reputation_reversal.sql`           | `reverse_reputation_for_feedback`                                     |
| `supabase/migrations/0019_revise_rating.sql`                 | `revise_rating` with reversing pairs                                  |
| `apps/web/src/components/reputation/ReputationCard.tsx`      | Total / count / avg / badge                                           |
| `apps/web/src/components/reputation/ReputationExplainer.tsx` | "What is this?" copy                                                  |
| `apps/web/src/components/feedback/RatingStars.tsx`           | Read-only star display (input lands T09)                              |
| `packages/domain/src/reputation.ts`                          | Types, badge logic, formatting, copy constants                        |
| `packages/domain/src/types-separation.ts`                    | `CreditBalance` / `ReputationSummary` incompatible types              |
| `supabase/tests/008_reputation.sql`                          | pgTAP: rating rules, revision, reversal, aggregates, non-spendability |
| `tests/e2e/reputation.spec.ts`                               | Playwright: rate → profile shows updated reputation                   |

---

## 7. Implementation steps

- [ ] Migration `0017`: `refresh_profile_reputation`, `get_reputation`, badge threshold setting
- [ ] Migration `0018`: `reverse_reputation_for_feedback` (admin-only, audited)
- [ ] Migration `0019`: `revise_rating` with reversing pairs and window enforcement
- [ ] Write `packages/domain/src/reputation.ts` (badge tiers, formatting, copy constants)
- [ ] Write `packages/domain/src/types-separation.ts` proving the two systems cannot cross
- [ ] Build `ReputationCard`, `ReputationExplainer`, `RatingStars` (read-only)
- [ ] Surface reputation on `/u/[handle]` (T03 scaffold) — public read
- [ ] Ensure `rate_feedback` (T02) is wired to recompute aggregates (already calls `refresh_profile_reputation`)
- [ ] Wire moderation removal to `reverse_reputation_for_feedback` (called by T09's admin action)
- [ ] Write pgTAP suite `008_reputation.sql`
- [ ] Write the Playwright reputation spec
- [ ] Verify the non-spendability test passes (500 reputation, 0 credits → still blocked)
- [ ] Confirm no leaderboard/ordering view exists anywhere in schema or UI

---

## 8. Acceptance criteria

- [ ] Only the entry owner can rate; a third party attempting to rate raises an error
- [ ] A second rating on the same feedback raises `unique_violation`
- [ ] Self-rating is rejected
- [ ] Ratings outside 1–10 are rejected by validation and by the DB check
- [ ] Revising within the window adjusts the ledger with a −old/+new pair; `sum(delta)` stays correct
- [ ] Revising after the window is rejected
- [ ] Moderation reversal removes the score from the total and is audited in `moderation_actions`
- [ ] `get_reputation` returns total, ratedCount, average, and a badge for any profile
- [ ] Reputation is publicly readable by any member; the _same_ numbers are shown to the owner
- [ ] **A member with 500 reputation and 0 Credits still cannot submit** (non-spendability)
- [ ] No `feedback_earned` or `credit_ledger` write occurs as a side effect of rating
- [ ] No leaderboard/ranking query or view exists
- [ ] `ReputationSummary` is not assignable to `CreditBalance` and vice versa (type test)

---

## 9. Tests

- **pgTAP**: owner-only rating, rate-once, self-rating rejection, range enforcement, revision within/after window, moderation reversal, aggregate accuracy after every mutation type, and the **non-spendability negative test**
- **Unit**: badge tier boundaries (0/25/100/250), average computation with reversals, copy constants
- **Type test**: `// @ts-expect-error` on `const b: CreditBalance = reputationSummary` and vice versa
- **Integration**: rate a real feedback item via the RPC → giver's `reputation_total` increases by exactly the score → credits unchanged
- **E2E (Playwright)**: creator rates a member's feedback → visits that member's profile → sees the updated total, rated count, and average

---

## 10. Verification commands

```bash
supabase test db --file supabase/tests/008_reputation.sql
psql "$DATABASE_URL" -c "select u.handle, p.reputation_total, p.rated_feedback_count, p.reputation_avg from profiles p join profiles u on u.id=p.id order by p.reputation_total desc limit 10;"
psql "$DATABASE_URL" -c "select user_id, sum(delta) as reputation, count(*) from reputation_ledger group by 1 order by 2 desc limit 10;"
psql "$DATABASE_URL" -c "select p.handle, p.reputation_total from profiles p where p.reputation_total > 0 and coalesce((select sum(delta) from credit_ledger where user_id=p.id and status in ('available','held')),0) < 1;"  -- reputation-rich, credit-poor: expected
grep -rn "reputation_ledger" supabase/migrations | grep -i "credit_ledger"  -- must return 0 lines
```

---

## 11. Risks & mitigations

| Risk                                         | Mitigation                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Rating feels like a points mini-game         | Ratings are 1–10 _usefulness_ judged only by the recipient, framed as helpfulness, never compared publicly |
| Score farming via duplicate accounts         | Flag for admin review (T09); only content-owner ratings count; moderation can suspend and reverse          |
| Reputation conflated with Credits in the UI  | Separate components, separate types, separate copy, CI grep + type tests                                   |
| Reversals corrupt aggregates                 | Every mutation calls `refresh_profile_reputation`; ledger is the source of truth, aggregates are derived   |
| Rating a low-quality feedback feels punitive | Copy frames 1–10 as usefulness; recipients can revise within a window if they mis-tap                      |

---

## 12. Definition of done

A creator can rate received feedback 1–10 exactly once, revisions and moderation reversals net out correctly through an append-only ledger, profiles surface helpfulness clearly, and there is no code path — schema, SQL, or TypeScript — by which reputation can be spent or converted to Credits.
