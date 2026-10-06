# Feed ranking

The curated home feed ranks every active entry for the signed-in viewer with a
**deterministic, additive formula**. This document records the formula, the reason each
choice was made, and three worked examples. It is the operator's manual: retuning the
feed starts here.

## The formula

```
score = (overlap × hashtagWeight × freshnessWeight)
      + friendship
      + feedbackNeed
      + (likedOverlap × moreLikeBoost)
      + freshness
```

then multiplied by the diversity caps that apply:

```
final = base × (0.5 if over the per-creator cap)
             × (0.75 if over the per-platform cap)
```

Ordering is `(final_score DESC, published_at DESC, id ASC)`.

## The signals

| Term | Range | Default weight | Meaning |
| ---- | ----- | -------------- | ------- |
| `overlap` | [0, 1] | `hashtagWeight` 1.0 | Fraction of the VIEWER's profile hashtags that appear on the entry. |
| `friendship` | {0, 0.35} | `friendBoost` 0.35 | The author is a confirmed friend, in either direction. |
| `feedbackNeed` | {0, 0.15} | `feedbackNeedBoost` 0.15 | Nobody has responded to the entry yet (`removed_at IS NULL`). |
| `likedOverlap` | [0, 1] | `moreLikeBoost` 0.1 | Fraction of the viewer's "more like this" tag pool on the entry. |
| `freshness` | (0, 1] | `freshnessWeight` 1.0 | `2^(-ageHours / halfLife)`, half-life 36h, clamped to [0, 1]. |

Three decisions are worth stating because a future retune will be tempted to revisit them:

**Overlap divides by the viewer's profile size, not by a constant.** A member who chose
five precise hashtags scores a two-tag match at 0.4; a fixed divisor of 3 would score it
0.67 and punish narrow interests for being narrow. `hashtagOverlap(['a','b'], fiveTags)`
is 0.4 and there is no other correct answer — which is also why the task text's
`min(hits,3)/3` sketch was not adopted: it answers a different question.

**Feedback need is "has anyone responded", not "did the creator ask".** Gating the boost
on `asks_for_feedback` would reward creators for asking more often, which is an incentive
the product does not want. At 0.15 the boost cannot outrank a genuine interest match;
it exists to give an unanswered entry its first response.

**Diversity is a multiplier applied while selecting, not a subtraction and not a filter.**
A subtraction has no floor and a filter empties thin feeds. A multiplier degrades
gracefully: the eighth post from one creator still appears, just below everything that
isn't over a cap. Caps are 2 per creator and 6 per platform in the default feed.

## Why this entry? The reason codes

Every ranked row carries one `reason_code`, computed by the same SQL that computed the
score so the two cannot drift apart. Precedence is friend → shared hashtag → no-feedback
→ fresh. The member-facing labels live in `FEED_REASON_LABELS` (`@fydio/domain`) and in
`feed_reason_label` (SQL); the pgTAP suite and the regression suite both assert the two
agree.

| Code | Shown as | When |
| ---- | -------- | ---- |
| `friend` | From someone you're connected to | Author is a confirmed friend |
| `shared_hashtag` | Matches your hashtags | ≥1 tag in common, not a friend |
| `new_creator` | No feedback yet | No common tags, nobody has responded |
| `fresh` | Recently shared | None of the above |

## Tuning it

Weights arrive as `app.feed_*` session GUCs with the defaults above baked into both
`packages/env` (`FEED_*`) and the migration that created the function. An operator
retunes by setting the GUC at connection time — see T10 for how the `FEED_*`
environment variables reach the database. The documented defaults in the two places
must stay equal; a divergent default is a policy value nobody can find, and the
regression suite pins the constants on both sides.

`FEED_PAGE_SIZE` caps a single response at 50 regardless of what is asked, and
`FEED_MAX_AGE_HOURS` (720, i.e. 30 days) drops older entries entirely rather than
ranking them low.

## Worked examples

All three use the defaults, a viewer with five tags, and the pinned instant
`2026-03-01T12:00:00Z` the test suites use.

### 1. A friend's matching post beats a stranger's fresh one

- **A**: friend, 2 of 5 tags match, 2h old, no feedback.
- **B**: stranger, 0 tags match, just published, no feedback.

```
A: 0.4 × 1.0 × 1.0 + 0.35 + 0.15 + 0 + 2^(-2/36)   = 0.4 + 0.5 + 0.9622  = 1.8622
B: 0   × 1.0 × 1.0 + 0    + 0.15 + 0 + 2^(0)       = 0   + 0.15 + 1.0     = 1.1500
```

A wins by 0.7. Friendship plus interest dominate recency, which is the product's
actual claim: the feed is curated by taste and connection, not by a timestamp.

### 2. A full tag match outranks a much fresher no-match

- **A**: stranger, all 5 tags match, 3h old, HAS feedback.
- **B**: stranger, 0 tags match, just published, HAS feedback.

```
A: 1.0 × 1 + 0 + 0 + 0 + 2^(-3/36)  = 1.9439
B: 0   × 1 + 0 + 0 + 0 + 1.0        = 1.0000
```

Three hours of decay cost A only 0.06. Tag overlap is the dominant signal by design:
the entire freshness range fits inside one full tag match.

### 3. The third post from one creator is demoted, not dropped

Three entries from one author, base scores 2.11, 2.11, 2.08, and a stranger's entry at
1.15. The third is over the per-creator cap of 2, so it scores `2.08 × 0.5 = 1.04` and
sorts AFTER the stranger's 1.15 — while a fourth page of the feed still contains it
rather than an absence. The `demoted` flag in the payload records that a cap moved it.

## What the feed does NOT do

- **No machine learning.** "Transparent ranking" demands scores a member can inspect
  and an operator can reproduce by hand. The regression suite exists so the two
  implementations stay identical; an ML model would make that suite meaningless.
- **No negative personalization beyond the member's own controls.** `hide` and
  `less_like` remove an entry for the viewer who pressed them and nobody else. There
  is no global downranking, no shadow mechanism, and the signals never leave Fydio.
- **No own entries.** A member never sees their own work as discovery.
- **No entries past the freshness window.** Older than 720h is gone, not ranked low.

## Verification

```bash
# pgTAP: formula, ordering, keysets, caps, exclusions, reasons (81 tests)
pnpm db:test

# Unit: reference properties the parity suite relies on (30 tests)
pnpm --filter @fydio/web test -- ranking.test.ts

# Parity: SQL vs TypeScript on shared fixtures (9 tests, needs the stack)
pnpm --filter @fydio/web test -- ranking.regression.test.ts

# E2E: reasons render, hide/mute persist, filters and paging (3 tests)
pnpm --filter @fydio/web test:e2e -- feed.spec.ts
```
