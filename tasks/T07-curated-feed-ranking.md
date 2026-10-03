# T07 — Curated Home Feed: Deterministic Ranking & Tuning Signals

**Status:** Not started
**Depends on:** T02, T03
**Blocks:** T08, T09, T10
**Brief reference:** §4 Curated home feed, §principle 4 "Transparent ranking", §Include "Feed ranking by tag overlap, friends, freshness, and diversity", "Use deterministic ranking first."

---

## 1. Goal

Build the scrollable home feed and its **deterministic** ranking function:

```
relevance = tag_match + friend_affinity + freshness + feedback_need + diversity_adjustment
```

with transparent "why this appeared" reasons, plus the tuning controls (more/less like this, mute creator, hide item).

After T07 a signed-in member sees a personalized, varied, explainable feed that loads incrementally and never shows muted or hidden content.

---

## 2. Why this position in the plan

This is the product's centerpiece — the "curated feeds" in the tagline. It needs entries (T04), profile hashtags (T03), and friendships (T03), all of which now exist. Tuning signals here are also prerequisites for T08's impression tracking.

---

## 3. Scope

### In scope

- `rank_feed` RPC: deterministic SQL ranking with all five signals
- "Why you're seeing this" transparency payload on every card
- Keyset (cursor) pagination — no offset pagination
- Feed impression logging (`feed_impressions`)
- Tuning controls: more like this, less like this, hide item, mute creator
- Feed filters by platform and tag pool
- Entry-card UI: creator, platform, thumbnail/link-card, title/caption, 3 hashtags, feedback prompt, ranking reason
- Empty state, exhausted-feed state, load-more
- Ranking regression tests (SQL vs the `packages/domain` reference implementation)

### Explicitly out of scope

- Outbound click tracking / opened state (T08) — cards render the link; T08 records the click
- Machine-learned ranking — explicitly excluded for MVP; "transparent ranking" demands deterministic, inspectable scores
- Infinite scroll virtualization beyond a simple "Load more"

---

## 4. Deliverables

1. `rank_feed` RPC (replacing the T02 stub) with the full scoring model
2. Feed page at `/feed` with cards, reasons, and pagination
3. Feed signal RPCs wired to UI controls
4. `feed_impressions` logging on render
5. Platform + tag-pool filters
6. Regression test suite proving SQL output matches the `packages/domain/ranking.ts` reference
7. Ranking documentation with worked examples

---

## 5. Technical design

### 5.1 Scoring model

Each signal is normalized to roughly `[0, 1]` then weighted. Weights come from `@fydio/env` via `current_setting`, so operators tune them without a migration.

```sql
create or replace function rank_feed(
  p_limit     int default null,
  p_cursor    timestamptz default null,
  p_platforms platform_kind[] default null
)
returns table (
  rank        int,
  entry       jsonb,
  score       numeric,
  reason_code text
)
language sql stable security definer set search_path = public
as $$
with cfg as (
  select
    current_setting('app.feed_friend_affinity_boost', true)::numeric        as w_friend,
    current_setting('app.feed_feedback_need_boost', true)::numeric         as w_need,
    current_setting('app.feed_freshness_half_life_hours', true)::numeric   as half_life,
    current_setting('app.feed_diversity_max_per_creator', true)::int       as max_creator,
    current_setting('app.feed_diversity_max_per_platform', true)::int      as max_platform,
    current_setting('app.feed_max_age_hours', true)::numeric                as max_age,
    coalesce(p_limit, current_setting('app.feed_page_size', true)::int)    as lim
),
viewer as (
  select
    auth.uid() as uid,
    -- The viewer's five profile hashtags: the primary matching signal
    (select coalesce(array_agg(hashtag_id), '{}') from profile_hashtags where profile_id = auth.uid()) as my_tags,
    (select coalesce(array_agg(requester_id), '{}') from friendships
      where addressee_id = auth.uid() and state='accepted') as f_friends,
    (select coalesce(array_agg(addressee_id), '{}') from friendships
      where requester_id = auth.uid() and state='accepted') as f_friends_rev,
    (select coalesce(array_agg(muted_profile_id), '{}') from mutes where viewer_id = auth.uid()) as muted
),
scored as (
  select
    ce.id,
    ce.author_id,
    ce.platform,
    ce.published_at,
    ce.asks_for_feedback,
    (select count(*) from content_hashtags ch
      where ch.content_entry_id = ce.id
        and ch.hashtag_id = any(v.my_tags))::numeric as tag_hits,
    (ce.author_id = any(v.f_friends) or ce.author_id = any(v.f_friends_rev)) as is_friend,
    -- FEEDBACK NEED: entries asking for feedback, weighted by how few they have
    case when ce.asks_for_feedback then
      1.0 / (1.0 + (select count(*) from feedback f where f.entry_id = ce.id and f.removed_at is null))
    else 0 end::numeric as need_raw
  from content_entries ce, viewer v, cfg c
  where ce.status = 'active'
    and ce.published_at > now() - make_interval(hours => c.max_age)
    and ce.author_id <> v.uid                                  -- never show your own
    and not (ce.author_id = any(v.muted))                      -- muted creators hidden
    and (p_platforms is null or ce.platform = any(p_platforms))
    -- hide: any 'hide' signal from this viewer removes the entry entirely
    and not exists (select 1 from feed_signals fs
                     where fs.viewer_id = v.uid and fs.entry_id = ce.id and fs.signal = 'hide')
    -- less_like_this: a hard penalty, not an exclusion
    and coalesce((select -1.0 from feed_signals fs
                   where fs.viewer_id = v.uid and fs.entry_id = ce.id and fs.signal = 'less_like'), 0) = 0
),
normalized as (
  select
    s.*,
    -- tag_match: 3 tags max, so overlap/3 normalizes to [0,1]
    least(s.tag_hits, 3) / 3.0 as tag_score,
    -- friend_affinity: transparent, limited boost (a 0 or 1 binary, weighted small)
    case when s.is_friend then 1.0 else 0.0 end as friend_score,
    -- freshness: exponential decay with configurable half-life
    power(0.5, extract(epoch from (now() - s.published_at)) / 3600.0 / c.half_life) as fresh_score,
    need_raw as need_score
  from scored s, cfg c
),
ranked as (
  select
    n.*,
    ( n.tag_score   * 1.0                       -- tag overlap: primary signal
    + n.friend_score * c.w_friend               -- limited, transparent boost
    + n.fresh_score  * 1.0                      -- gradual decay
    + n.need_score   * c.w_need ) as base_score
  from normalized n, cfg c
)
-- DIVERSITY: demote entries whose creator or platform is already over-represented
-- in the running result set (greedy penalty applied in the outer query)
select
  row_number() over (order by r.base_score - d.penalty desc, r.published_at desc)::int,
  jsonb_build_object(
    'id', ce.id, 'platform', ce.platform, 'title', ce.title,
    'captionExcerpt', ce.caption_excerpt, 'thumbnailPath', ce.thumbnail_path,
    'thumbnailSource', ce.thumbnail_source, 'previewState', ce.preview_state,
    'creatorNote', ce.creator_note, 'asksForFeedback', ce.asks_for_feedback,
    'publishedAt', ce.published_at, 'originalUrl', ce.original_url,
    'author', jsonb_build_object(
      'handle', pr.handle, 'displayName', pr.display_name,
      'avatarPath', pr.avatar_path, 'reputationTotal', pr.reputation_total),
    'tags', (select jsonb_agg(jsonb_build_object('slug', h.slug, 'label', h.label)
                              order by ch.position)
               from content_hashtags ch join hashtags h on h.id = ch.hashtag_id
              where ch.content_entry_id = ce.id),
    'reason', (select reason_code from ranked_reason(ce.id, r.base_score) )
  ),
  r.base_score,
  reason_code_for(r.base_score, r.tag_score, r.friend_score, r.fresh_score, r.need_score)
from ranked r
join content_entries ce on ce.id = r.id
join profiles pr on pr.id = ce.author_id
cross join lateral (
  -- diversity penalty: how many higher-ranked entries share this creator / platform
  select case when
      (select count(*) from ranked r2 where r2.author_id = r.author_id
         and (r2.base_score > r.base_score)) >= c.max_creator then -0.25 else 0 end
    + case when
      (select count(*) from ranked r2 where r2.platform = r.platform
         and (r2.base_score > r.base_score)) >= c.max_platform then -0.15 else 0 end as penalty
) d
cross join cfg c
where (p_cursor is null or (r.published_at, r.base_score) < (p_cursor, ...))
order by r.base_score - d.penalty desc, r.published_at desc
limit (select lim from cfg);
$$;
```

> **Implementation note:** the diversity penalty and pagination cursor are shown here in readable form. In the final migration, the diversity penalty is computed in a second CTE over the ordered result so it is a single pass (a `cross join lateral` re-scan is O(n²) and will not survive real data). The scoring math — the part that must be identical to the TypeScript reference — is unchanged.

### 5.2 Transparency: "why you're seeing this"

Every card carries a `reason` object derived from the contributing signals, never a raw score:

| Condition                   | Reason shown                              |
| --------------------------- | ----------------------------------------- |
| tag_score > 0 and is_friend | "Shared hashtags with someone you follow" |
| tag_score > 0               | "Matches your interests (#tag)"           |
| is_friend                   | "From someone you're connected to"        |
| fresh_score high            | "Recently shared"                         |
| needs feedback              | "Creator is asking for feedback"          |
| none dominant               | "Popular in Fydio right now"              |

This satisfies the brief's principle 4: _"Show members why an item appears: shared hashtag, friend connection, or freshness."_ Reasons are computed in SQL alongside the score so they can never drift from the ranking.

### 5.3 Impressions

`feed_impressions` records what the user actually saw, for both open-rate metrics and the personalization model:

```ts
// apps/web/src/app/feed/actions.ts (server action)
'use server'
import { createServerClient } from '@fydio/supabase/server'

export async function logImpressions(entryIds: string[]) {
  const supabase = createServerClient(await cookies())
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || entryIds.length === 0) return
  await supabase.from('feed_impressions').upsert(
    entryIds.map((entry_id, i) => ({
      entry_id,
      viewer_id: user.id,
      position: i + 1,
      served_at: new Date().toISOString(),
    })),
    { onConflict: 'viewer_id,entry_id' },
  )
}
```

Impressions are logged from a client effect when cards enter the viewport (IntersectionObserver), not on render — a card scrolled past should not count as a view of content.

### 5.4 Pagination

Keyset pagination on `(published_at, score)` to stay stable as new content arrives:

```ts
export async function loadMoreFeed(cursor: { publishedAt: string; score: number }) {
  const { data, error } = await supabase.rpc('rank_feed', {
    p_limit: FEED_PAGE_SIZE,
    p_cursor: cursor.publishedAt,
  })
  ...
}
```

Offset pagination would duplicate or skip entries whenever someone publishes mid-scroll — unacceptable in a 30-person community where publishing is frequent.

### 5.5 Tuning controls

| Control        | Effect                                                     | Mechanism                                                                                                      |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| More like this | Boosts entries sharing tags with the liked entry           | `feed_signals` `more_like`; the ranking adds `+0.1` to entries with tag overlap with the signaled entry's tags |
| Less like this | Penalizes that entry and its creator's similar-tag entries | `feed_signals` `less_like`; hard −1.0 exclusion plus creator-tag penalty                                       |
| Hide item      | Removes the entry from this viewer's feed permanently      | `feed_signals` `hide`; excluded in the ranking WHERE clause                                                    |
| Mute creator   | Hides all entries by that creator                          | `mutes` table; excluded in the ranking WHERE clause                                                            |

All signals affect **only** Fydio's recommendations — the brief is explicit: "These signals affect only Fydio's recommendations." None of them touch the platform, the creator, or any external system.

### 5.6 Feed page

`/feed` layout:

- Sticky header: Fydio wordmark, tag-pool filter, platform filter chips
- Card stack: `FeedEntryCard` per §4 (creator identity, platform badge, thumbnail or link card, title/caption excerpt, exactly 3 hashtags, feedback prompt, ranking reason chip, tuning menu)
- "Load more" button + `LoadMoreFeed` client component
- Empty state: "Nothing new yet — adjust your hashtags or check back soon"
- Responsive: single column mobile, single column desktop (feed-centric), respecting the "opens in a new tab" behavior.

Card ranking-reason chip is subtle (small, muted) — informative, not loud.

---

## 6. Files to create

| Path                                                 | Purpose                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `supabase/migrations/0020_rank_feed.sql`             | Full `rank_feed` implementation replacing the T02 stub                    |
| `supabase/migrations/0021_feed_signals_effect.sql`   | more/less-like tag-affinity effect, mute/hide integration                 |
| `supabase/migrations/0022_ranking_reasons.sql`       | `ranked_reason` / `reason_code_for` transparency helper                   |
| `apps/web/src/app/feed/page.tsx`                     | Feed page (RSC)                                                           |
| `apps/web/src/app/feed/actions.ts`                   | `loadMoreFeed`, `logImpressions`, signal server actions                   |
| `apps/web/src/app/feed/FeedClient.tsx`               | Client feed with pagination + impression observer                         |
| `apps/web/src/components/feed/FeedEntryCard.tsx`     | Entry card                                                                |
| `apps/web/src/components/feed/RankingReasonChip.tsx` | "Why you're seeing this"                                                  |
| `apps/web/src/components/feed/FeedFilters.tsx`       | Platform + tag-pool filters                                               |
| `apps/web/src/components/feed/TuningMenu.tsx`        | More/Less/Mute/Hide controls                                              |
| `packages/domain/src/ranking.ts`                     | Reference implementation (from T01) — already exists; now mirrored by SQL |
| `tests/ranking/regression.test.ts`                   | SQL vs TypeScript parity                                                  |
| `supabase/tests/009_feed_ranking.sql`                | pgTAP: ordering, diversity, mutes/hides, reasons                          |
| `docs/architecture/ranking.md`                       | Scoring model + worked examples                                           |

---

## 7. Implementation steps

- [ ] Migration `0020`: implement `rank_feed` (tags, friends, freshness, need, diversity) replacing the stub
- [ ] Migration `0021`: `more_like` tag-affinity effect, `less_like` penalty, mute/hide exclusion (all in the WHERE/score)
- [ ] Migration `0022`: `reason_code_for` / `ranked_reason` transparency functions
- [ ] Tune default weights via `current_setting` (`packages/env`): friend 0.35, need 0.15, half-life 36h, max 2/creator, 6/platform
- [ ] Write `docs/architecture/ranking.md` with three worked examples (tag match, friend, fresh)
- [ ] Build `FeedEntryCard` with all §4 elements and the ranking-reason chip
- [ ] Build `/feed` page (RSC) reading the first page via `rank_feed`
- [ ] Build `FeedClient` with keyset "Load more" and IntersectionObserver impression logging
- [ ] Build `FeedFilters` (platform chips + tag pool) wired to `p_platforms` / cursor reset
- [ ] Build `TuningMenu` wired to `submit_feed_signal`, `mute_creator`, `unmute_creator`
- [ ] Verify muted creators and hidden entries never appear for that viewer
- [ ] Verify `less_like_this` removes the entry and `more_like_this` surfaces similar-tag entries
- [ ] Write the SQL-vs-TypeScript regression test
- [ ] Write pgTAP suite `009_feed_ranking.sql`
- [ ] Confirm determinism: the same viewer + same data yields the same order across calls

---

## 8. Acceptance criteria

- [ ] Every card shows a human-readable ranking reason (tag match, friend, or freshness)
- [ ] Ranking is deterministic — repeated identical calls return identical order
- [ ] A friend's entry outranks an equally-fresh non-friend's entry with equal tag overlap
- [ ] Tag overlap dominates: a 3/3 tag match outranks a 0/0 match even if the latter is much fresher
- [ ] Diversity caps hold: at most `max_creator` entries from any one creator in the first page (unless fewer exist)
- [ ] Freshness decays — a 72h-old entry scores below a fresh one with equal other signals
- [ ] Entries with `asks_for_feedback` receive the configured modest boost
- [ ] Muted creators' entries are absent for that viewer (and only that viewer)
- [ ] Hidden entries are absent permanently for that viewer
- [ ] `less_like_this` removes/hides the entry; `more_like_this` surfaces related-tag entries
- [ ] Your own entries never appear in your feed
- [ ] Keyset pagination loads more without duplicating or skipping entries
- [ ] Impression logging fires on viewport entry, not page render
- [ ] SQL ranking matches the `packages/domain/ranking.ts` reference within tolerance on the shared fixtures
- [ ] Empty state renders when no entries match

---

## 9. Tests

- **Regression (`tests/ranking`)**: shared fixture set (N entries × M viewers with known tag overlap, friendships, ages) run through both the SQL function and the TypeScript reference; assert score parity within `1e-6` and order parity.
- **pgTAP**: rank ordering under controlled scores; diversity cap; mute/hide exclusion; own-entries-excluded; determinism (two calls equal); reasons non-null.
- **Unit (`packages/domain/ranking.ts`)**: freshness half-life math (at 1× half-life score ≈ 0.5), tag normalization, diversity penalty activation thresholds.
- **Integration**: with seeded data, feed returns ≥1 page, no duplicates across pages, mutes respected.
- **E2E (Playwright)**: view feed → see reasons → hide an item → reload → item gone → mute a creator → their entries gone.

---

## 10. Verification commands

```bash
supabase test db --file supabase/tests/009_feed_ranking.sql
pnpm --filter @fydio/web test -- ranking

psql "$DATABASE_URL" -c "select rank, (entry->'reason'->>'code') as reason, (entry->>'platform') as platform, (entry->'author'->>'handle') as author, round(score,4) as score from rank_feed(20, null, null);"
psql "$DATABASE_URL" -c "select author_id, count(*) from (select unnest(jsonb_array_elements(jsonb_agg(entry->'author'->'id'))) as author_id from rank_feed(20,null,null)) t group by 1 having count(*) > 2;"  -- diversity cap
psql "$DATABASE_URL" -c "select count(*) from feed_impressions where served_at > now() - interval '1 hour';"
```

---

## 11. Risks & mitigations

| Risk                                         | Mitigation                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Ranking feels arbitrary without transparency | Every card carries a reason; weights are documented in `ranking.md`                                          |
| A single prolific creator floods the feed    | Diversity penalty (max per creator / per platform) + friend boost capped small                               |
| Personalization creates a filter bubble      | Tag match dominates but freshness and diversity counterbalance; reasons make the logic legible               |
| O(n²) diversity scan is slow                 | Compute the penalty in an ordered second CTE (single pass), with the lateral form shown only for readability |
| New entries shift the feed mid-scroll        | Keyset pagination on `(published_at, score)`, not offset                                                     |
| Feed feels stale because few new entries     | `FEED_MAX_AGE_HOURS` window plus a freshness boost; seed spans 30 days so the window is exercised            |
| Ranking drifts from the TypeScript reference | Regression test runs both implementations over shared fixtures in CI                                         |

---

## 12. Definition of done

A member sees a fast, deterministic, diverse, and explainable feed built on their five hashtags, their confirmed friendships, and freshness — with working tuning controls that affect only Fydio's recommendations.
