import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DIVERSITY,
  DEFAULT_WEIGHTS,
  FEED_REASON_LABELS,
  FEED_REASONS,
  freshnessDecay,
  hashtagOverlap,
  rankFeed,
  scoreCandidate,
  type FeedReason,
  type RankCandidate,
  type ViewerContext,
} from '@fydio/domain'
import { feedEntryPayloadSchema } from '@fydio/supabase'

/**
 * Ranking unit tests for T07 (task §9).
 *
 * Two things live here and nowhere else:
 *
 *   1. The `more like this` term, which T07 added to the formula.
 *   2. The properties the parity suite relies on being true of the REFERENCE — if
 *      the reference is wrong, a passing parity test proves nothing.
 *
 * SQL-vs-TypeScript parity itself is in `tests/ranking/regression.test.ts`, which
 * needs a live stack. Everything here is pure and runs in CI with no database.
 *
 * The clock is FIXED. Every assertion uses `NOW`, because a test that reads the real
 * clock drifts by a few milliseconds on each run and a freshness term is exactly the
 * kind of value a 1e-6 tolerance would catch.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const hoursBefore = (n: number) => new Date(NOW.getTime() - n * HOUR)

const VIEWER_TAGS = ['design', 'motion', 'typography']

function candidate(overrides: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id: 'entry-1',
    authorId: 'author-1',
    platform: 'youtube',
    hashtags: ['design', 'motion'],
    createdAt: hoursBefore(2),
    hasFeedback: false,
    isFriend: false,
    ...overrides,
  }
}

function viewer(overrides: Partial<ViewerContext> = {}): ViewerContext {
  return {
    viewerId: 'viewer-1',
    profileHashtags: VIEWER_TAGS,
    likedHashtags: [],
    seenEntryIds: [],
    seenAuthors: new Map(),
    seenPlatforms: new Map(),
    ...overrides,
  }
}

describe('freshnessDecay — the properties SQL mirrors', () => {
  it('halves at exactly one half-life', () => {
    expect(freshnessDecay(36, 36)).toBeCloseTo(0.5, 12)
  })

  it('clamps a future-dated entry to 1 rather than exceeding it', () => {
    // The SQL clamps with least(1, greatest(0, ...)) for the same reason:
    // `published_at` is member-supplied, so this is reachable, not theoretical.
    expect(freshnessDecay(-10, 36)).toBe(1)
  })

  it('treats a zero half-life as "no decay" rather than dividing by zero', () => {
    // SQL guards this with `nullif(v_half_life, 0)` in the denominator; without it
    // the function would raise on `app.feed_freshness_half_life_hours = 0`.
    expect(freshnessDecay(100, 0)).toBe(1)
  })
})

describe('hashtagOverlap — the normalisation SQL mirrors', () => {
  it('divides by the VIEWER profile size, not by a constant', () => {
    // This is the T07 decision the task text got wrong. With three viewer tags, two
    // matches is 2/3 — NOT 2/3 of an assumed "three tags per entry" either way, but
    // crucially not a fixed divisor of 3 that would score a five-tag viewer wrongly.
    expect(hashtagOverlap(['design', 'motion'], VIEWER_TAGS)).toBeCloseTo(2 / 3, 12)
    expect(hashtagOverlap(['design', 'motion'], [...VIEWER_TAGS, 'colour', 'audio'])).toBeCloseTo(
      0.4,
      12,
    )
  })

  it('returns 0 for a viewer with no hashtags, which SQL matches via nullif', () => {
    expect(hashtagOverlap(['design'], [])).toBe(0)
  })
})

describe('the more-like-this term', () => {
  it('contributes exactly nothing when the viewer has liked nothing', () => {
    const baseline = scoreCandidate(candidate(), VIEWER_TAGS, { now: NOW })
    const withEmptyPool = scoreCandidate(candidate(), VIEWER_TAGS, {
      now: NOW,
      likedHashtags: [],
    })

    expect(baseline.moreLike).toBe(0)
    expect(withEmptyPool.moreLike).toBe(0)
    expect(withEmptyPool.score).toBe(baseline.score)
  })

  it('is additive, and independent of the profile-hashtag term', () => {
    // The candidate matches the profile on design+motion (2 of 3 viewer tags), and
    // the liked pool is motion+colour — both of which the entry carries. Overlap is
    // measured against the POOL's size, so it is 2/2 = 1 and the boost is the full
    // 0.1.
    //
    // The two ratios having different denominators is the point: the same two tags
    // are worth 2/3 as an ambient interest and 1 as a deliberate press.
    const score = scoreCandidate(
      candidate({ hashtags: ['design', 'motion', 'colour'] }),
      VIEWER_TAGS,
      { now: NOW, likedHashtags: ['motion', 'colour'] },
    )

    expect(score.likedOverlap).toBeCloseTo(1, 12)
    expect(score.moreLike).toBeCloseTo(DEFAULT_WEIGHTS.moreLikeBoost, 12)
    expect(score.overlap).toBeCloseTo(2 / 3, 12)
  })

  it('is a smaller lever than a profile hashtag', () => {
    // Deliberate: an ambient interest the member set once should not be
    // overridable by one press, and the reverse is equally true.
    const viaProfile = scoreCandidate(
      candidate({ hashtags: ['design'], hasFeedback: true }),
      VIEWER_TAGS,
      { now: NOW },
    )
    const viaLike = scoreCandidate(
      candidate({ hashtags: ['design'], hasFeedback: true }),
      VIEWER_TAGS,
      { now: NOW, likedHashtags: ['design'] },
    )

    expect(viaProfile.overlap).toBeCloseTo(1 / 3, 12)
    expect(viaLike.likedOverlap).toBeCloseTo(1, 12)
    expect(viaProfile.relevance).toBeGreaterThan(viaLike.moreLike)
  })

  it('surfaces a related entry that would otherwise rank below an unrelated one', () => {
    const entries = rankFeed(
      [
        candidate({
          id: 'unrelated',
          hashtags: ['cooking'],
          createdAt: hoursBefore(2),
          hasFeedback: true,
        }),
        candidate({
          id: 'related',
          hashtags: ['motion', 'colour'],
          createdAt: hoursBefore(24),
          hasFeedback: true,
        }),
      ],
      viewer({ likedHashtags: ['motion', 'colour'] }),
      { now: NOW },
    )

    expect(entries[0]?.id).toBe('related')
  })
})

describe('the scoring formula', () => {
  /**
   * Pins every term, in order. T07 mirrors this expression in SQL and the parity
   * suite diffs the two, so any reordering or regrouping of the sum has to surface
   * here first rather than as a 1e-6 drift in CI.
   */
  it('is the documented sum of five terms', () => {
    const score = scoreCandidate(
      candidate({ hashtags: ['design', 'motion'], isFriend: true, hasFeedback: false }),
      VIEWER_TAGS,
      { now: NOW, likedHashtags: ['design'] },
    )

    // likedHashtags is a one-tag pool the entry fully matches, so the ratio is 1 and
    // the term is the whole boost.
    const expected =
      (2 / 3) * DEFAULT_WEIGHTS.hashtagWeight * DEFAULT_WEIGHTS.freshnessWeight +
      DEFAULT_WEIGHTS.friendBoost +
      DEFAULT_WEIGHTS.feedbackNeedBoost +
      DEFAULT_WEIGHTS.moreLikeBoost +
      score.freshness

    expect(score.score).toBeCloseTo(expected, 12)
  })

  it('keeps a full tag match above a much fresher no-match', () => {
    // The T07 acceptance criterion: "a 3/3 tag match outranks a 0/0 match even if
    // the latter is much fresher." Three hours is enough to overcome the entire
    // freshness range, which is what makes tag overlap the dominant signal.
    const matched = scoreCandidate(
      candidate({ hashtags: VIEWER_TAGS, createdAt: hoursBefore(3), hasFeedback: true }),
      VIEWER_TAGS,
      { now: NOW },
    )
    const stale = scoreCandidate(
      candidate({ hashtags: ['cooking'], createdAt: NOW, hasFeedback: true }),
      VIEWER_TAGS,
      { now: NOW },
    )

    expect(matched.score).toBeGreaterThan(stale.score)
  })

  it('ranks a friend above an equal-tag non-friend of identical age', () => {
    const friend = scoreCandidate(
      candidate({ hashtags: ['design'], isFriend: true }),
      VIEWER_TAGS,
      { now: NOW },
    )
    const stranger = scoreCandidate(
      candidate({ hashtags: ['design'], isFriend: false }),
      VIEWER_TAGS,
      { now: NOW },
    )

    expect(friend.score).toBeCloseTo(stranger.score + DEFAULT_WEIGHTS.friendBoost, 12)
  })
})

describe('diversity', () => {
  it('demotes rather than drops, so a thin feed still fills', () => {
    const shared = VIEWER_TAGS
    const entries = rankFeed(
      [
        candidate({ id: 'a1', authorId: 'author-x', hashtags: shared }),
        candidate({ id: 'a2', authorId: 'author-x', hashtags: shared }),
        candidate({ id: 'a3', authorId: 'author-x', hashtags: shared, createdAt: hoursBefore(6) }),
        candidate({ id: 'a4', authorId: 'author-x', hashtags: shared, createdAt: hoursBefore(8) }),
      ],
      viewer(),
      { now: NOW },
    )

    expect(entries).toHaveLength(4)
    expect(entries.filter((entry) => entry.demoted)).toHaveLength(2)
    for (const entry of entries) {
      if (entry.demoted) {
        expect(entry.score).toBeCloseTo(entry.baseScore * DEFAULT_WEIGHTS.diversityPenalty, 12)
      }
    }
  })

  /**
   * The property the SQL must also hold, and the one the old implementation broke:
   * a demoted entry has to MOVE DOWN, or the penalty is cosmetic.
   */
  it('re-sorts by the penalised score so a demotion is observable', () => {
    // Fixture arithmetic matters here, so it is derived rather than guessed:
    //   a1, a2 (2h old, full tag match, no feedback)   base 2.1122
    //   a3        (4h old, full tag match, no feedback) base 2.0759 -> x0.5 = 1.0380
    //   stranger  (now,    no overlap,    no feedback)  base 1.1500
    //
    // `a3` outranks `stranger` on its raw score and falls below it once penalised, so
    // the re-sort is the only thing that can produce the asserted order. Without it
    // `a3` would keep the slot its raw score earned and the cap would be cosmetic.
    const entries = rankFeed(
      [
        candidate({ id: 'a1', authorId: 'author-x', hashtags: VIEWER_TAGS }),
        candidate({ id: 'a2', authorId: 'author-x', hashtags: VIEWER_TAGS }),
        candidate({
          id: 'stranger',
          authorId: 'author-y',
          hashtags: ['cooking'],
          createdAt: NOW,
          hasFeedback: false,
        }),
        candidate({ id: 'a3', authorId: 'author-x', hashtags: VIEWER_TAGS, createdAt: hoursBefore(4) }),
      ],
      viewer(),
      { now: NOW, diversity: DEFAULT_DIVERSITY },
    )

    const order = entries.map((entry) => entry.id)
    const byId = new Map(entries.map((entry) => [entry.id, entry]))

    expect(order).toEqual(['a1', 'a2', 'stranger', 'a3'])
    expect(byId.get('a3')?.demoted).toBe(true)
    // The two facts that make the order above the correct one.
    expect(byId.get('a3')?.baseScore ?? 0).toBeGreaterThan(byId.get('stranger')?.score ?? 0)
    expect(byId.get('stranger')?.score ?? 0).toBeGreaterThan(byId.get('a3')?.score ?? 0)
  })

  it('is a multiplier with a floor, so a demoted entry stays ranked', () => {
    // A SUBTRACTIVE penalty can push a score below zero, which sorts an entry ahead
    // of nothing while looking like a successful demotion. The reference's choice to
    // multiply is what guarantees the floor.
    const entries = rankFeed(
      [
        candidate({ id: 'a1', authorId: 'author-x', hashtags: VIEWER_TAGS }),
        candidate({ id: 'a2', authorId: 'author-x', hashtags: VIEWER_TAGS }),
        candidate({ id: 'a3', authorId: 'author-x', hashtags: VIEWER_TAGS, createdAt: hoursBefore(4) }),
      ],
      viewer(),
      { now: NOW },
    )

    for (const entry of entries) {
      expect(entry.score).toBeGreaterThan(0)
    }
  })

  it('caps creators and platforms independently', () => {
    const entries = rankFeed(
      [
        candidate({ id: 'p1', authorId: 'author-1', platform: 'youtube' }),
        candidate({
          id: 'p2',
          authorId: 'author-2',
          platform: 'youtube',
          createdAt: hoursBefore(1),
        }),
      ],
      viewer(),
      { now: NOW, diversity: { maxPerCreator: 10, maxPerPlatform: 1 } },
    )

    expect(entries[0]?.demoted).toBe(false)
    expect(entries[1]?.demoted).toBe(true)
  })

  it('applies the cap across pages, seeded from what has been shown', () => {
    // The reason `ViewerContext` carries `seenAuthors` as COUNTS: caps that restart
    // on every page let one creator appear twice on page 1 and twice more at the top
    // of page 2. SQL gets this for free by ranking the whole corpus at once; the
    // reference is handed one page and has to be told what came before.
    //
    // Two is the cap, and the caller has already seen this author twice — so the
    // NEXT entry is the third and is demoted.
    const entries = rankFeed(
      [candidate({ id: 'next', authorId: 'author-x', hashtags: VIEWER_TAGS })],
      viewer({ seenAuthors: new Map([['author-x', 2]]) }),
      { now: NOW },
    )

    expect(entries[0]?.demoted).toBe(true)
  })

  /**
   * The property a `Set<string>` could not express. A set holding "author-x" twice
   * still has size 1, so the cap would never trip for the one case it exists for.
   */
  it('distinguishes "seen once" from "seen twice" when seeding', () => {
    const seenOnce = rankFeed(
      [candidate({ id: 'next', authorId: 'author-x', hashtags: VIEWER_TAGS })],
      viewer({ seenAuthors: new Map([['author-x', 1]]) }),
      { now: NOW },
    )
    const seenTwice = rankFeed(
      [candidate({ id: 'next', authorId: 'author-x', hashtags: VIEWER_TAGS })],
      viewer({ seenAuthors: new Map([['author-x', 2]]) }),
      { now: NOW },
    )

    expect(seenOnce[0]?.demoted).toBe(false)
    expect(seenTwice[0]?.demoted).toBe(true)
  })
})

describe('determinism', () => {
  const tied = [
    candidate({ id: 'b', authorId: 'author-b' }),
    candidate({ id: 'a', authorId: 'author-a' }),
  ]

  it('produces the same order regardless of input order', () => {
    const first = rankFeed(tied, viewer(), { now: NOW }).map((entry) => entry.id)
    const second = rankFeed([...tied].reverse(), viewer(), { now: NOW }).map((entry) => entry.id)

    expect(first).toEqual(second)
  })

  it('produces identical scores across repeated calls', () => {
    const first = rankFeed(tied, viewer(), { now: NOW })
    const second = rankFeed(tied, viewer(), { now: NOW })

    expect(second.map((entry) => entry.score)).toEqual(first.map((entry) => entry.score))
  })

  it('breaks a full tie on id, so the order is total', () => {
    const entries = rankFeed(tied, viewer(), { now: NOW })

    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('exclusions', () => {
  it('never shows the viewer their own entry', () => {
    expect(rankFeed([candidate({ authorId: 'viewer-1' })], viewer(), { now: NOW })).toHaveLength(0)
  })

  it('drops entries past the freshness window', () => {
    const entries = rankFeed(
      [
        candidate({ id: 'old', createdAt: hoursBefore(1000) }),
        candidate({ id: 'fresh', createdAt: NOW }),
      ],
      viewer(),
      { now: NOW, maxAgeHours: 720 },
    )

    expect(entries.map((entry) => entry.id)).toEqual(['fresh'])
  })
})

describe('transparency vocabulary', () => {
  /**
   * The guard for the three places the reason vocabulary is written down:
   * `FEED_REASONS` here, `feed_impressions_reason_code_known` in SQL, and the
   * `reason_code` values `ranked_reason` can emit.
   *
   * They are asserted equal in the pgTAP suite too, because neither language can see
   * the other's list on its own. If a fifth reason is added to one and not the other,
   * one of these two tests fails — which is the point.
   */
  it('matches the SQL CHECK constraint, exactly', () => {
    expect([...FEED_REASONS].sort()).toEqual(
      ['friend', 'fresh', 'new_creator', 'shared_hashtag'].sort(),
    )
  })

  it('has a label for every reason', () => {
    for (const reason of FEED_REASONS) {
      expect(FEED_REASON_LABELS[reason]).toBeTruthy()
      // A label equal to its own code would render as `fresh` on a card, which is a
      // silent failure the type system cannot catch.
      expect(FEED_REASON_LABELS[reason]).not.toBe(reason)
    }
  })
})

describe('the rank_feed payload parser', () => {
  const valid = {
    id: 'e1',
    platform: 'youtube',
    title: 'A post',
    captionExcerpt: null,
    thumbnailPath: null,
    thumbnailSource: null,
    previewState: 'resolved',
    creatorNote: null,
    asksForFeedback: true,
    publishedAt: '2026-03-01T00:00:00.000Z',
    originalUrl: 'https://youtube.com/watch?v=1',
    demoted: false,
    author: {
      id: 'a1',
      handle: 'someone',
      displayName: 'Someone',
      avatarPath: null,
      reputationTotal: 0,
    },
    tags: [{ id: 'h1', slug: 'design', label: 'Design' }],
  }

  it('accepts a well-formed payload', () => {
    expect(feedEntryPayloadSchema.safeParse(valid).success).toBe(true)
  })

  /**
   * The reason this file exists. PostgREST types a `jsonb` return as `Json`, so a
   * projection change in the SQL would otherwise reach the card as `undefined` for
   * every field — a blank card with no error anywhere.
   */
  it('rejects a payload missing a field the SQL projects', () => {
    const { author: _author, ...withoutAuthor } = valid

    expect(feedEntryPayloadSchema.safeParse(withoutAuthor).success).toBe(false)
  })

  it('rejects a platform the enum has never heard of', () => {
    // A hand-typed or stale query parameter must not be able to widen the enum.
    expect(feedEntryPayloadSchema.safeParse({ ...valid, platform: 'facebook' }).success).toBe(false)
  })

  it('requires tags to be an array even when empty', () => {
    expect(feedEntryPayloadSchema.safeParse({ ...valid, tags: [] }).success).toBe(true)
    expect(feedEntryPayloadSchema.safeParse({ ...valid, tags: null }).success).toBe(false)
  })
})

describe('reason codes are the four the UI can render', () => {
  it('narrows the DB string to FeedReason without losing the check', () => {
    const codes: readonly string[] = FEED_REASONS

    for (const code of codes) {
      expect((code as FeedReason) in FEED_REASON_LABELS).toBe(true)
    }
  })
})