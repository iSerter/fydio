-- =============================================================================
-- T07 · 0020 — The curated feed ranker
-- =============================================================================
--
-- Replaces the T02 stub `rank_feed` with the real ranking function.
--
-- WHY THIS REPRODUCES `packages/domain/ranking.ts` AND NOT THE TASK'S SKETCH.
--
-- The T07 task text sketches a formula: tag hits / 3, a `1/(1+n)` feedback-need
-- term, and additive diversity penalties of -0.25 / -0.15. `packages/domain`
-- already ships a DIFFERENT one: tag overlap divided by the viewer's own profile
-- size, flat friend and feedback-need boosts, and MULTIPLICATIVE diversity
-- penalties.
--
-- Both are individually defensible. They cannot both be "the" formula, and the
-- T07 acceptance criteria name `packages/domain/ranking.ts` as the oracle the SQL
-- is diffed against. So this migration reproduces the TypeScript exactly, and
-- `apps/web/test/ranking.regression.test.ts` proves it on shared fixtures. The
-- brief's SQL block is a sketch; the shipped reference is the specification.
--
-- Where the reference is right and the sketch is not:
--
--   * Tag overlap divides by the VIEWER's profile size, not by a constant 3. A
--     member who chose five precise hashtags should score a two-tag match at 0.4,
--     not 0.67 — otherwise a narrow interest profile is punished for being narrow.
--   * Diversity is a MULTIPLIER, applied while selecting. A subtraction has no
--     floor: a subtraction large enough to bury a prolific creator's eighth entry
--     would also bury a legitimately great one, and in a 30-member community the
--     caps are hit constantly. A multiplier degrades gracefully and never empties
--     a feed.
--   * Ranking runs over the WHOLE visible corpus, not one page. Page 1 and page 2
--     are slices of one total order, which is what makes the keyset cursor
--     coherent. Ranking per page would let the same creator appear twice on page 1
--     and twice more at the top of page 2.
--
-- --- Tunables -------------------------------------------------------------------
--
-- 0001 shipped `app_setting_int` only. Half of these weights are fractional — a
-- 0.35 friend boost — and an integer read would truncate them to 0 and silently
-- disable the signal. `nullif(..., '')` guards the empty-string case: an operator
-- who writes `app.feed_friend_affinity_boost=` gets `''`, and `''::numeric` is a
-- cast error that takes the entire feed down. Empty means unset, so it falls back.

create or replace function public.app_setting_num(p_name text, p_default numeric)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(nullif(current_setting(p_name, true), '')::numeric, p_default);
$$;

-- The count-valued settings need the same tolerance: `app_setting_int` raises on
-- `'2.0'` where a numeric read accepts it, and these are caps an operator is
-- invited to tune by hand.
create or replace function public.app_setting_num_int(p_name text, p_default integer)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(nullif(current_setting(p_name, true), '')::numeric, p_default::numeric)::integer;
$$;

-- Feed weight defaults for the session this migration runs in.
--
-- NOTE ON WHY THIS IS NOT `ALTER DATABASE ... SET`. 0001 sets its defaults the same
-- way and its header claims they become "a session default for every future
-- connection". They do not: `set_config(..., false)` is session-scoped, and
-- `ALTER DATABASE ... SET` is refused outright for a custom GUC on this stack
-- because the `postgres` role is not a superuser (verified:
-- `select usesuper from pg_user where usename = current_user` -> f).
--
-- That is fine, and it is why every read below carries its default twice: once as
-- the `p_default` argument to `app_setting_num`, which is the value that actually
-- applies when no GUC is set. The DO block only takes effect for the rest of this
-- migration's own session.
--
-- THE REAL TUNING PATH is a connection-level `set` from the application, which
-- overrides whatever is here and is what T10 wires to the `FEED_*` environment
-- variables. That is also why every read is written as
-- `coalesce(<guc>, <default>)` rather than trusting the GUC to exist: an unset
-- GUC must mean "use the MVP default", never "disable the signal".
--
-- Every value below mirrors `packages/env`'s `FEED_*` schema. If one side changes,
-- change both: a divergent default is a policy value nobody can find.
do $$
declare
  defaults text[][] := array[
    array['app.feed_page_size', '20'],
    array['app.feed_hashtag_weight', '1.0'],
    array['app.feed_friend_affinity_boost', '0.35'],
    array['app.feed_feedback_need_boost', '0.15'],
    array['app.feed_more_like_boost', '0.1'],
    array['app.feed_freshness_half_life_hours', '36'],
    array['app.feed_freshness_weight', '1.0'],
    array['app.feed_diversity_penalty', '0.5'],
    array['app.feed_platform_penalty', '0.75'],
    array['app.feed_diversity_max_per_creator', '2'],
    array['app.feed_diversity_max_per_platform', '6'],
    array['app.feed_max_age_hours', '720']
  ];
  item text[];
begin
  foreach item slice 1 in array defaults loop
    perform set_config(item[1], item[2], false);
  end loop;
end;
$$;

-- =============================================================================
-- ranked_reason — why this entry is here
-- =============================================================================
--
-- The task file list puts the transparency helpers in 0022, but `rank_feed` below
-- calls this one, and a function cannot depend on something a LATER migration
-- creates. So it is defined here, immediately before its only caller, and 0022
-- carries the rest of the transparency surface (the reason vocabulary, the
-- member-facing labels, and the diagnostics view).
--
-- Computed in SQL rather than in the client from the returned score components, so
-- a card can never claim a reason the ranking no longer supports.
--
-- ORDER IS THE PRODUCT DECISION. "From someone you're connected to" is a stronger
-- and more specific claim than "Matches your hashtags", so it wins when both hold:
-- a member shown a friend's post should be told that, not the weaker half-truth.
-- `fresh` closes the list as the baseline, because an entry with no reason at all
-- is a bug in the caller rather than a user-facing state.

create or replace function public.ranked_reason(
  p_is_friend      boolean,
  p_tag_overlap    boolean,
  p_needs_feedback boolean
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_is_friend      then 'friend'
    when p_tag_overlap    then 'shared_hashtag'
    when p_needs_feedback then 'new_creator'
    else 'fresh'
  end;
$$;

comment on function public.ranked_reason(boolean, boolean, boolean) is
  'The strongest single reason this entry is in the viewer''s feed. Mirrors explainRank in @fydio/domain.';

-- =============================================================================
-- rank_feed
-- =============================================================================
--
-- SIGNATURE CHANGE, AND WHY EXISTING CALLERS KEEP WORKING.
--
-- 0007's stub was `rank_feed(p_limit, p_cursor, p_platforms)`. This adds four
-- optional parameters AFTER `p_platforms`, so every existing call keeps working and
-- keeps its meaning. `p_cursor` is still "published strictly before this instant";
-- `p_cursor_score` and `p_cursor_id` narrow it into a true keyset.
--
-- WHY THE KEYSET NEEDS ALL THREE. Ordering is
-- `(final_score desc, published_at desc, id asc)`. A cursor on `published_at`
-- alone is stable only while no two entries share both a score and a timestamp. The
-- moment they do, a boundary entry is either repeated on the next page or skipped.
-- Carrying the whole sort key makes the cursor a position in the total order rather
-- than a guess at one component of it.
--
-- When `p_cursor_score` is supplied the caller must supply all three. A partial
-- keyset compares against NULL and returns nothing, and an empty feed with no error
-- reads as "nobody has posted" rather than "the cursor was malformed" — so the
-- partial case raises instead. Passing only `p_cursor` keeps 0007's time-fence
-- behaviour for any caller not yet updated.
--
-- `p_tags` is the "tag pool" filter: entries carrying any of these hashtags. NULL
-- means no filter, so omitting it is the default feed.
--
-- EMPTY ARRAYS ALSO MEAN "NO FILTER", which is not a convenience. `'{}' = any(x)` is
-- false for every row, so an empty array passed straight through would match nothing
-- and return an empty feed — the same visible result as "this member has no
-- friendships" or "the feed is broken". A caller that builds a filter array by
-- mapping over a selection (the obvious way to write one) would hit this the moment
-- a member deselected everything. `cardinality(...) = 0` makes null and empty
-- behave identically, so the distinction cannot become a silent outage.
--
-- `p_now` exists so the regression suite can pin the clock and compare against
-- TypeScript's `now` option. It never mutates; the function stays `stable`.

-- BOTH the T02 stub AND the previous version of THIS function are dropped first.
--
-- Two separate reasons, and the second is the one that bites:
--
--   * `create or replace` matches on the exact argument list, so widening the
--     signature would silently leave the 3-argument stub in place as an overload —
--     and then `rank_feed(20, null, null)` is ambiguous and fails with "function is
--     not unique" for every caller.
--   * `create or replace` CANNOT CHANGE A FUNCTION'S RETURN TYPE. Changing `score`
--     from `numeric` to `text` without dropping first raises
--     "cannot change return type of existing function", which is Postgres correctly
--     refusing to reinterpret a column that callers are already reading.
--
-- This drop is also what makes the migration idempotent: re-running it recreates the
-- function rather than failing against itself.
drop function if exists public.rank_feed(integer, timestamptz, platform_kind[]);
drop function if exists public.rank_feed(integer, timestamptz, platform_kind[], numeric, uuid, uuid[], timestamptz);

create or replace function public.rank_feed(
  p_limit        integer         default 20,
  p_cursor       timestamptz     default null,
  p_platforms    platform_kind[] default null,
  p_cursor_score numeric         default null,
  p_cursor_id    uuid            default null,
  p_tags         uuid[]          default null,
  p_now          timestamptz     default null
)
returns table (
  rank        bigint,
  entry       jsonb,
  -- TEXT, not numeric. This is the single most surprising thing in the signature and it
  -- is deliberate.
  --
  -- `final_score` is exact decimal arithmetic, so it carries far more significant
  -- digits than an IEEE double can hold. PostgREST serialises `numeric` as a JSON
  -- NUMBER, the browser parses it into a double, and the digits beyond ~16 are lost.
  -- When the client sends that value back as `p_cursor_score`, the comparison
  -- `final_score = p_cursor_score` is FALSE for the very row the cursor came from —
  -- the stored value is fractionally larger than the double that represents it — so
  -- that row is silently skipped and the member's feed loses an entry at every page
  -- boundary.
  --
  -- Returning the score as text makes the round-trip exact: the digits the database
  -- produced are the digits the database compares. The cost is that callers must
  -- `Number()` it for display, which is what they were doing anyway.
  score       text,
  reason_code text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();

  -- Pinned once, not per row. Reading `now()` inside the scoring expression would
  -- make two rows' freshness depend on where the planner evaluated them. One read,
  -- one clock.
  v_now timestamptz := coalesce(p_now, now());

  v_has_keyset boolean := p_cursor_score is not null;

  -- Read once, up front. Re-reading `current_setting` per row would cost a lookup
  -- per candidate and let a concurrent retune change the answer mid-query.
  v_w_tag        numeric := public.app_setting_num('app.feed_hashtag_weight', 1.0);
  v_w_friend     numeric := public.app_setting_num('app.feed_friend_affinity_boost', 0.35);
  v_w_need       numeric := public.app_setting_num('app.feed_feedback_need_boost', 0.15);
  v_w_more_like  numeric := public.app_setting_num('app.feed_more_like_boost', 0.1);
  v_w_freshness  numeric := public.app_setting_num('app.feed_freshness_weight', 1.0);
  v_half_life    numeric := public.app_setting_num('app.feed_freshness_half_life_hours', 36);
  v_w_diversity  numeric := public.app_setting_num('app.feed_diversity_penalty', 0.5);
  v_w_platform   numeric := public.app_setting_num('app.feed_platform_penalty', 0.75);
  v_max_creator  integer := public.app_setting_num_int('app.feed_diversity_max_per_creator', 2);
  v_max_platform integer := public.app_setting_num_int('app.feed_diversity_max_per_platform', 6);
  v_max_age      numeric := public.app_setting_num('app.feed_max_age_hours', 720);
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- A half-supplied keyset would compare against NULL and return nothing at all.
  if v_has_keyset and (p_cursor is null or p_cursor_id is null) then
    raise exception
      'A score cursor requires p_cursor (published_at) and p_cursor_id as well; pass all three or none'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with viewer as (
    -- `array_agg` over zero rows returns NULL, not an empty array, so `coalesce` is
    -- load-bearing: `x = any(NULL)` is NULL, and NULL propagates through the score
    -- into an unpredictable sort position. A member with no hashtags yet must still
    -- receive a ranked feed rather than a broken one.
    select
      v_uid as uid,

      -- The viewer's profile hashtags: the primary matching signal.
      coalesce((
        select array_agg(ph.hashtag_id)
          from public.profile_hashtags ph
         where ph.profile_id = v_uid
      ), '{}') as my_tags,

      -- Confirmed friends, BOTH directions. `friendships` stores one row per pair
      -- with a `pair_key`, so which side sent the request is presentation and
      -- affinity is mutual. Reading only `requester_id` would make friendship rank
      -- asymmetrically, which is exactly what `005_friendships.sql` forbids.
      coalesce((
        select array_agg(f.addressee_id)
          from public.friendships f
         where f.requester_id = v_uid and f.state = 'accepted'
      ), '{}') as friends_out,

      coalesce((
        select array_agg(f.requester_id)
          from public.friendships f
         where f.addressee_id = v_uid and f.state = 'accepted'
      ), '{}') as friends_in,

      coalesce((
        select array_agg(m.muted_profile_id)
          from public.mutes m
         where m.viewer_id = v_uid
      ), '{}') as muted,

      -- The tags of entries this viewer pressed "more like this" on.
      --
      -- The affinity signal is the TAGS, not the entries. Pressing it once on a
      -- motion-graphics post should lift every other motion-graphics post — that is
      -- what makes it a taste signal rather than a bookmark. A member who has set
      -- no hashtags can still steer the feed this way.
      coalesce((
        select array_agg(distinct ch.hashtag_id)
          from public.feed_signals fs
          join public.content_hashtags ch on ch.content_entry_id = fs.entry_id
         where fs.viewer_id = v_uid
           and fs.signal = 'more_like'
      ), '{}') as liked_tags
  ),
  candidates as (
    select
      ce.id,
      ce.author_id,
      ce.platform,
      ce.published_at,

      -- Tag overlap: how many of the viewer's hashtags this entry carries, over how
      -- many the viewer has.
      --
      -- THE ORDER OF `coalesce` AND `least` IS LOAD-BEARING, and this is the single
      -- subtlest thing in the function. Written the other way round — as
      -- `least(1, coalesce(<ratio>, 0))` — it is WRONG, and wrong in the worst
      -- direction: `least`/`greatest` IGNORE null arguments in Postgres rather than
      -- propagating them. So `least(1, NULL)` is **1**, not NULL, and the outer
      -- `coalesce` never fires. Every entry would then score a perfect 1.0 overlap,
      -- and with an empty hashtag pool (a member who has set no tags) that means
      -- every entry in the entire feed gets the FULL friend-equivalent tag boost —
      -- which is exactly the bug this ordering guards against.
      --
      -- Coalescing the RATIO first makes the value a real 0 before it reaches
      -- `least`, so the clamp has something to clamp.
      coalesce(least(1, coalesce((
        select count(*)::numeric
          from public.content_hashtags ch
         where ch.content_entry_id = ce.id
           and ch.hashtag_id = any (v.my_tags)
      ) / nullif(array_length(v.my_tags, 1), 0), 0)), 0) as tag_overlap,

      -- The same ratio against the "more like this" pool. Kept separate from the
      -- profile pool so an explicit press is distinguishable from an ambient
      -- interest, and so the two boosts add rather than compete.
      coalesce(least(1, coalesce((
        select count(*)::numeric
          from public.content_hashtags ch
         where ch.content_entry_id = ce.id
           and ch.hashtag_id = any (v.liked_tags)
      ) / nullif(array_length(v.liked_tags, 1), 0), 0)), 0) as liked_overlap,

      (ce.author_id = any (v.friends_out) or ce.author_id = any (v.friends_in)) as is_friend,

      -- "Has anyone responded yet", NOT "did the creator ask". An entry nobody has
      -- commented on is the one that most needs a first response, and at 0.15 the
      -- boost cannot outrank a genuine interest match. Gating on
      -- `asks_for_feedback` instead would reward creators for asking more often,
      -- which is an incentive the product does not want.
      not exists (
        select 1 from public.feedback f
         where f.entry_id = ce.id and f.removed_at is null
      ) as needs_feedback
    from public.content_entries ce
    cross join viewer v
   where ce.status = 'active'
     -- Never show a member their own work back at them as discovery.
     and ce.author_id <> v.uid
     -- The freshness window. Past it an entry is not ranked low, it is gone: a
     -- month-old post competing with today's is worse than not seeing it.
     --
     -- `make_interval` declares `hours` as `int`, not a float, so the numeric GUC
     -- needs an explicit cast. Handing it a `numeric` is a function-resolution
     -- error at run time rather than a silent coercion.
     and ce.published_at >= v_now - make_interval(hours => v_max_age::int)
     -- Muted creators, for this viewer only. A preference, not a block.
     and not (ce.author_id = any (v.muted))
     -- Platform filter. BOTH null and empty mean "no filter" — see the empty-array note.
     and (p_platforms is null or cardinality(p_platforms) = 0 or ce.platform = any (p_platforms))
     -- Tag-pool filter. Same.
     and (
       p_tags is null
       or cardinality(p_tags) = 0
       or exists (
         select 1 from public.content_hashtags ch
          where ch.content_entry_id = ce.id
             and ch.hashtag_id = any (p_tags)
       )
     )
     -- `hide` and `less_like` remove the entry from this viewer's feed entirely.
     --
     -- Not a -1.0 penalty: the task text describes them both ways, and the
     -- exclusion reading is the one that matches the words a member clicks. It is
     -- also the only one that makes the control verifiable — a penalty strong
     -- enough to hide something is a hide with extra steps. 0021 makes these rows
     -- actually persistable; under 0007 they were deleted on write, so this
     -- predicate could never match anything.
     and not exists (
       select 1 from public.feed_signals fs
        where fs.viewer_id = v.uid
          and fs.entry_id = ce.id
          and fs.signal in ('hide', 'less_like')
     )
  ),
  scored as (
    select
      c.*,

      -- Freshness: 2^(-ageHours / halfLife), clamped to [0, 1]. The clamp is not
      -- decoration: `published_at` is member-supplied, so a future-dated entry would
      -- otherwise score above 1 and outrank everything in the feed permanently.
      least(1, greatest(0, power(2::numeric, -(
        extract(epoch from (v_now - c.published_at)) / 3600.0
      ) / nullif(v_half_life, 0)))) as freshness,

      -- The score, assembled exactly as `scoreCandidate` assembles it:
      --
      --   relevance * freshnessWeight + friendship + feedbackNeed + freshness
      --
      -- where `relevance = overlap * hashtagWeight`. Kept in that order and that
      -- shape rather than "simplified", because the regression test diffs this
      -- expression against the TypeScript term by term and regrouping the sum moves
      -- the last decimal place.
      (
          c.tag_overlap * v_w_tag * v_w_freshness
        + case when c.is_friend then v_w_friend else 0 end
        + case when c.needs_feedback then v_w_need else 0 end
        + c.liked_overlap * v_w_more_like
        + least(1, greatest(0, power(2::numeric, -(
            extract(epoch from (v_now - c.published_at)) / 3600.0
          ) / nullif(v_half_life, 0))))
      )::numeric as base_score
    from candidates c
  ),
  ordered as (
    -- A deterministic order BEFORE diversity, because the penalty depends on it:
    -- whether an entry breaches its creator's cap is a function of how many of that
    -- creator's entries rank above it.
    --
    -- `row_number() over (partition by ...)` yields that count for the whole corpus
    -- in a single pass. The task's sketch used a `cross join lateral` counting
    -- higher-ranked rows per candidate — the same arithmetic, but O(n²) and a full
    -- re-scan of the ranked set once per row, which will not survive real data.
    --
    -- `id` as the final tie-break is what makes the feed reproducible: two entries
    -- with an identical score and timestamp would otherwise be ordered by whatever
    -- the planner preferred, and a feed that reshuffles on refresh reads as broken.
    select
      s.*,
      row_number() over (
        partition by s.author_id
        order by s.base_score desc, s.published_at desc, s.id asc
      ) as creator_seq,
      row_number() over (
        partition by s.platform
        order by s.base_score desc, s.published_at desc, s.id asc
      ) as platform_seq
    from scored s
  ),
  penalized as (
    -- Caps apply to the MULTIPLIER, creator first then platform, matching the
    -- reference. Both can fire at once and they are independent: three YouTube posts
    -- from one creator are both a creator problem and a platform one.
    --
    -- The multiplier is applied TO the base score. Without `o.base_score *` this
    -- column would be the penalty factor alone — a constant 1.0 for every entry that
    -- is within every cap — and the feed would rank purely by publication time while
    -- appearing to rank by score.
    select
      o.*,
      (
          o.base_score
        * case when o.creator_seq  > v_max_creator  then v_w_diversity else 1 end
        * case when o.platform_seq > v_max_platform then v_w_platform  else 1 end
      )::numeric as final_score,
      (o.creator_seq > v_max_creator or o.platform_seq > v_max_platform) as demoted
    from ordered o
  ),
  ranked as (
    -- Rank assigned BEFORE the cursor filter, so it is the absolute slot in the
    -- corpus rather than the index within this page. The client's "load more" must
    -- continue one numbering, and an impression's `position` has to mean the slot
    -- the member actually saw.
    select
      p.*,
      row_number() over (order by p.final_score desc, p.published_at desc, p.id asc) as abs_rank
    from penalized p
  )
  select
    r.abs_rank,
    jsonb_build_object(
      'id', ce.id,
      'platform', ce.platform,
      'title', ce.title,
      'captionExcerpt', ce.caption_excerpt,
      'thumbnailPath', ce.thumbnail_path,
      'thumbnailSource', ce.thumbnail_source,
      'previewState', ce.preview_state,
      'creatorNote', ce.creator_note,
      'asksForFeedback', ce.asks_for_feedback,
      'publishedAt', ce.published_at,
      'originalUrl', ce.original_url,
      'demoted', r.demoted,
      'author', jsonb_build_object(
        'id', pr.id,
        'handle', pr.handle,
        'displayName', pr.display_name,
        'avatarPath', pr.avatar_path,
        'reputationTotal', pr.reputation_total
      ),
      -- '[]' rather than NULL: a card always renders a hashtag row, and coalescing
      -- in TypeScript would be one more place for the two implementations to drift.
      'tags', coalesce((
        select jsonb_agg(jsonb_build_object('id', h.id, 'slug', h.slug, 'label', h.label)
                         order by ch.position)
          from public.content_hashtags ch
          join public.hashtags h on h.id = ch.hashtag_id
         where ch.content_entry_id = ce.id
      ), '[]'::jsonb)
    ),
    r.final_score::text,
    -- Computed by the same SQL that computed the score, so a card can never claim a
    -- reason the ranking no longer supports.
    public.ranked_reason(r.is_friend, r.tag_overlap > 0, r.needs_feedback)
  from ranked r
  join public.content_entries ce on ce.id = r.id
  join public.profiles pr on pr.id = ce.author_id
  where
    -- The keyset, written out longhand rather than as a tuple comparison.
    --
    -- A ROW comparison would be the obvious thing here — `(a, b, c) < (x, y, z)` reads
    -- like exactly what is needed — and it is WRONG. The ordering is
    -- `(final_score DESC, published_at DESC, id ASC)`: the id component runs the
    -- OPPOSITE way to the other two, and a tuple comparison assumes a single
    -- direction. With a tuple, any row sharing the cursor's score and timestamp but
    -- sorting after it on `id ASC` compares as "before the cursor" and is DROPPED.
    -- The symptom is a page boundary that silently skips entries whose scores tie —
    -- which is exactly what happened, and what the pgTAP suite and the parity test
    -- now both cover.
    --
    -- The id is compared with `>` because it is the only ASC component. `id ASC` is
    -- kept (rather than made DESC to suit the tuple) because the TypeScript reference
    -- tie-breaks with `localeCompare`, and changing the SQL to DESC would break parity
    -- on every tied row.
    case
      when v_has_keyset then
           r.final_score < p_cursor_score
        or (r.final_score = p_cursor_score and r.published_at < p_cursor)
        or (r.final_score = p_cursor_score and r.published_at = p_cursor and r.id > p_cursor_id)
      -- 0007's time fence, still honoured for a caller that passes only `p_cursor`.
      when p_cursor is not null
        then ce.published_at < p_cursor
      else true
    end
  order by r.final_score desc, r.published_at desc, r.id asc
  limit greatest(1, least(coalesce(p_limit, public.app_setting_num_int('app.feed_page_size', 20)), 50));
end;
$$;

comment on function public.rank_feed(integer, timestamptz, platform_kind[], numeric, uuid, uuid[], timestamptz) is
  'Ranks active entries for the signed-in viewer. Mirrors @fydio/domain scoreCandidate/rankFeed exactly; docs/architecture/ranking.md records the worked examples.';

-- The index the tag-pool filter and the per-candidate tag-overlap subquery both want.
-- 0005's primary key is `(content_entry_id, hashtag_id)`, which cannot serve a lookup
-- by hashtag alone — and tag overlap is evaluated once per candidate entry, so this
-- sits on the hot path of every feed load.
create index if not exists content_hashtags_hashtag_idx
  on public.content_hashtags (hashtag_id);

-- The tag-affinity lookup joins `feed_signals` to `content_hashtags` on entry_id and
-- filters on (viewer, signal). 0007's index leads with `viewer_id` and `created_at`,
-- so this filter has to scan every signal the viewer ever sent.
create index if not exists feed_signals_viewer_signal_idx
  on public.feed_signals (viewer_id, signal);

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop index if exists public.feed_signals_viewer_signal_idx;
-- drop index if exists public.content_hashtags_hashtag_idx;
-- drop function if exists public.rank_feed(integer, timestamptz, platform_kind[], numeric, uuid, uuid[], timestamptz);
-- drop function if exists public.ranked_reason(boolean, boolean, boolean);
-- (the 0007 stub is restored by re-running that migration's body)
-- drop function if exists public.app_setting_num_int(text, integer);
-- drop function if exists public.app_setting_num(text, numeric);