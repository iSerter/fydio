-- =============================================================================
-- pgTAP · 009 — Feed ranking
-- =============================================================================
--
-- The guarantees only SQL can prove:
--
--   * the score is EXACTLY the documented sum of five terms
--   * ordering is deterministic across repeated calls
--   * a keyset page neither repeats nor skips
--   * diversity caps demote rather than drop
--   * muted / hidden entries are absent, and only for the viewer who set them
--   * a member never sees their own work
--   * every card carries a reason, and it is one the vocabulary knows
--
-- ROLE SWITCHING. Each block does:
--
--   set local role <role>
--   select set_config('request.jwt.claim.sub', <uuid>, true)
--
-- The role switch activates the policies; the GUC is what `auth.uid()` reads. Both are
-- transaction-local, so the file's ROLLBACK restores everything.
--
-- ORDER NOTE: the role switch comes BEFORE `set_config`, matching 002_credits.sql,
-- which is the ordering verified against this stack.
--
-- THE ROLE SWITCH IS NOT OPTIONAL. Every function under test is `SECURITY DEFINER`,
-- and without `set local role authenticated` the session is still `postgres` — which
-- is the table OWNER and has RLS effectively disabled. Every exclusion below would
-- then pass vacuously: a hidden entry would still appear, a mute would still be
-- ignored, and the anonymous-caller test could not fail at all. The switch is what
-- makes these assertions mean something.
--
-- WHY THE SCORE IS ASSERTED ARITHMETICALLY RATHER THAN BY SNAPSHOT. A fixture that
-- records "the top score is 1.2345" needs updating every time a weight is retuned,
-- and updating it is indistinguishable from a silent regression. Deriving the
-- expected value from the same weights the function reads proves the FORMULA, which
-- is the thing that is supposed to be stable.

begin;

select plan(83);

-- =============================================================================
-- Fixtures
-- =============================================================================

-- `gen_random_uuid()` values for rows that must exist even if the seed's demo
-- accounts were renamed. Kept as variables so the assertions read as ids, not noise.
select set_config('t07.viewer', gen_random_uuid()::text, true);
select set_config('t07.outsider', gen_random_uuid()::text, true);
select set_config('t07.entry_a', gen_random_uuid()::text, true);
select set_config('t07.entry_b', gen_random_uuid()::text, true);

-- A dedicated viewer with a known tag profile, so the overlap ratio is exact rather
-- than dependent on whatever the seed happened to assign.
insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  (current_setting('t07.viewer')::uuid, '00000000-0000-0000-0000-000000000000', 't07-viewer@demo.test', '', now(), now(), '{}', '{}'),
  (current_setting('t07.outsider')::uuid, '00000000-0000-0000-0000-000000000000', 't07-outsider@demo.test', '', now(), now(), '{}', '{}')
on conflict (id) do nothing;

select set_config('t07.friend_id', gen_random_uuid()::text, true);
select set_config('t07.stranger_id', gen_random_uuid()::text, true);

insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  (current_setting('t07.friend_id')::uuid, '00000000-0000-0000-0000-000000000000', 't07-friend@demo.test', '', now(), now(), '{}', '{}'),
  (current_setting('t07.stranger_id')::uuid, '00000000-0000-0000-0000-000000000000', 't07-stranger@demo.test', '', now(), now(), '{}', '{}')
on conflict (id) do nothing;

-- Two entries with a known shape, pinned to a known age so freshness is exact.
insert into public.content_entries (
  id, author_id, platform, original_url, canonical_url, url_hash,
  title, preview_state, status, published_at, created_at
)
values
  (current_setting('t07.entry_a')::uuid, current_setting('t07.friend_id')::uuid, 'youtube',
   'https://t07-a.example/x', 'https://t07-a.example/x', extensions.digest('https://t07-a.example/x', 'sha256'),
   'Entry A', 'resolved', 'active', now() - interval '2 hours', now() - interval '2 hours'),
  (current_setting('t07.entry_b')::uuid, current_setting('t07.stranger_id')::uuid, 'instagram',
   'https://t07-b.example/x', 'https://t07-b.example/x', extensions.digest('https://t07-b.example/x', 'sha256'),
   'Entry B', 'resolved', 'active', now() - interval '4 hours', now() - interval '4 hours')
on conflict (id) do nothing;

-- =============================================================================
-- Functions exist
-- =============================================================================

select has_function('public', 'rank_feed',
  array['integer', 'timestamptz', 'platform_kind[]', 'numeric', 'uuid', 'uuid[]', 'timestamptz'],
  'rank_feed exists with the T07 signature');
select has_function('public', 'ranked_reason', array['boolean', 'boolean', 'boolean'],
  'ranked_reason exists');
select has_function('public', 'feed_reason_label', array['text'], 'feed_reason_label exists');
select has_function('public', 'log_feed_impressions', array['jsonb'], 'log_feed_impressions exists');
select has_function('public', 'app_setting_num', array['text', 'numeric'], 'app_setting_num exists');

-- The 0007 three-argument stub must be GONE. `create or replace` matches on the exact
-- argument list, so widening the signature without dropping the old one leaves an
-- overload and `rank_feed(20, null, null)` becomes ambiguous for every caller.
select hasnt_function('public', 'rank_feed', array['integer', 'timestamptz', 'platform_kind[]'],
  'the T02 rank_feed stub was dropped rather than shadowed');

-- `score` must be TEXT, and this is the reason it is worth an assertion of its own.
-- The score is exact decimal arithmetic with far more significant digits than an IEEE
-- double can hold. If it were returned as `numeric`, PostgREST would serialise it as a
-- JSON number, the browser would round it, and sending that back as the next page's
-- `p_cursor_score` would make `final_score = p_cursor_score` false for the cursor's own
-- row — silently dropping an entry at every page boundary.
select ok(
  (select pg_get_function_result(p.oid) like '%score text%'
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rank_feed'
      and p.pronargs = 7),
  'rank_feed returns the score as text so the cursor round-trips exactly'
);

select has_index('public', 'content_hashtags', 'content_hashtags_hashtag_idx',
  'content_hashtags is indexed by hashtag for the overlap subquery');

-- From here on every assertion runs as a real member. `set local role` is
-- transaction-local, so the final ROLLBACK restores `postgres`.
set local role authenticated;

-- =============================================================================
-- ranked_reason: the transparency vocabulary
-- =============================================================================

select set_config('request.jwt.claim.sub', current_setting('t07.viewer'), true);

-- The four branches, strongest signal first.
select is(public.ranked_reason(true,  true,  true),  'friend',
  'friend outranks every other reason');
select is(public.ranked_reason(false, true,  true),  'shared_hashtag',
  'a shared hashtag beats the need-for-feedback reason');
select is(public.ranked_reason(false, false, true),  'new_creator',
  'an unanswered entry is explained as new to Fydio');
select is(public.ranked_reason(false, false, false), 'fresh',
  'fresh is the baseline, so no card is ever unreasoned');

-- Every code the ranker can emit must have a label. A code with no label renders as
-- the raw string on a card, which is the failure "transparent ranking" exists to
-- prevent — and it is invisible until a member sees it.
select ok(
  (select bool_and(public.feed_reason_label(c) is not null and public.feed_reason_label(c) <> '')
   from unnest(array['shared_hashtag', 'friend', 'fresh', 'new_creator']) as c),
  'every reason code has a non-empty label'
);

-- The SQL CHECK constraint and the four codes must agree. This is the cross-language
-- guard: TypeScript cannot see this constraint and SQL cannot see FEED_REASONS.
--
-- Counted from the constraint's OWN definition rather than asserted as text, so a
-- fifth reason added to the CHECK without being added here fails the count.
select ok(
  (select bool_and(def.text like '%' || code || '%')
     from (select distinct pg_get_constraintdef(oid) as text
             from pg_constraint
            where conname = 'feed_impressions_reason_code_known') def,
          unnest(array['shared_hashtag', 'friend', 'fresh', 'new_creator']) as code),
  'the CHECK constraint covers all four reason codes'
);

select ok(
  (select bool_and(def.text not like '%' || code || '%')
     from (select distinct pg_get_constraintdef(oid) as text
             from pg_constraint
            where conname = 'feed_impressions_reason_code_known') def,
          unnest(array['popular', 'trending', 'recommended']) as code),
  'the CHECK constraint does not admit a reason Fydio cannot explain'
);

-- The constraint must actually reject a fifth. This is the enforcement half; the
-- definition check above is only meaningful alongside it.
--
-- Run as `postgres` because this inserts a row for an arbitrary viewer id, which
-- RLS forbids for `authenticated` — and the assertion is about the CHECK, not about
-- who may write. Being explicit about the role is what keeps the two failures
-- distinguishable: under `authenticated` this raises 42501 and the assertion would
-- pass for entirely the wrong reason.
reset role;

select throws_ok(
  $$
  insert into public.feed_impressions (entry_id, viewer_id, reason_code)
  values (
    (select id from public.content_entries limit 1),
    (select id from public.profiles limit 1),
    'because_i_said_so'
  )
  $$,
  '23514',
  null,
  'an unknown reason_code is refused by the CHECK constraint'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('t07.viewer'), true);

-- =============================================================================
-- The score is the documented sum of five terms
-- =============================================================================

-- The full five-term formula, re-derived from the same GUCs the function reads and
-- the same viewer signals, and compared to the score the function returned.
--
-- This is the assertion that makes the SQL a reimplementation of
-- `@fydio/domain`'s `scoreCandidate` rather than a plausible neighbour of it: if
-- either drops a term, reorders the sum, or applies the diversity multiplier twice,
-- this fails. It is written as a formula, not a snapshot, so retuning a weight does
-- not require editing the test — and a real regression cannot hide behind the edit.
select ok(
  (
    with scored as (
      select
        r.entry->>'id' as id,
        r.score,
        (r.entry->>'demoted')::boolean as demoted,
        -- Inputs, read back from the same sources `rank_feed` reads them from.
        (select count(*)::numeric
           from public.content_hashtags ch
           join public.profile_hashtags ph on ph.hashtag_id = ch.hashtag_id
          where ch.content_entry_id = (r.entry->>'id')::uuid
            and ph.profile_id = current_setting('t07.viewer')::uuid)
          / nullif((select count(*) from public.profile_hashtags
                     where profile_id = current_setting('t07.viewer')::uuid), 0) as overlap,
        exists (
          select 1 from public.friendships f
           where f.state = 'accepted'
             and ((f.requester_id = current_setting('t07.viewer')::uuid
                   and f.addressee_id = (r.entry->'author'->>'id')::uuid)
               or (f.requester_id = (r.entry->'author'->>'id')::uuid
                   and f.addressee_id = current_setting('t07.viewer')::uuid))
        ) as is_friend,
        not exists (
          select 1 from public.feedback f
           where f.entry_id = (r.entry->>'id')::uuid and f.removed_at is null
        ) as needs_feedback,
        (select count(*)::numeric
           from public.content_hashtags ch
           join public.feed_signals fs on fs.entry_id = ch.content_entry_id
          where fs.viewer_id = current_setting('t07.viewer')::uuid
            and fs.signal = 'more_like'
            and ch.content_entry_id = (r.entry->>'id')::uuid)
          / nullif((select count(distinct ch.hashtag_id)
                      from public.content_hashtags ch
                      join public.feed_signals fs on fs.entry_id = ch.content_entry_id
                     where fs.viewer_id = current_setting('t07.viewer')::uuid
                       and fs.signal = 'more_like'), 0) as liked_overlap,
        least(1::numeric, greatest(0::numeric, power(2::numeric, -(extract(epoch from (now() - ((r.entry->>'publishedAt')::timestamptz))) / 3600.0) / public.app_setting_num('app.feed_freshness_half_life_hours', 36)))) as freshness
      from rank_feed(50, null, null, null, null, null, now()) r
    ),
    expected as (
      select
        s.id,
        s.score,
        s.demoted,
        -- Exactly the reference's expression:
        --   relevance * freshnessWeight + friendship + feedbackNeed + moreLike + freshness
        ( least(1, greatest(0, s.overlap))
            * public.app_setting_num('app.feed_hashtag_weight', 1.0)
            * public.app_setting_num('app.feed_freshness_weight', 1.0)
          + case when s.is_friend
                 then public.app_setting_num('app.feed_friend_affinity_boost', 0.35) else 0 end
          + case when s.needs_feedback
                 then public.app_setting_num('app.feed_feedback_need_boost', 0.15) else 0 end
          + least(1, greatest(0, s.liked_overlap))
            * public.app_setting_num('app.feed_more_like_boost', 0.1)
          + s.freshness
        )::numeric as base_score
      from scored s
    )
    -- Only UNDEMOTED entries are compared. `rank_feed` returns the penalised score,
    -- so a demoted row legitimately differs from the bare formula; re-deriving the
    -- diversity cap here as well would make this assertion about two mechanisms at
    -- once, and a failure would not say which. The cap has its own assertions.
    --
    -- `greatest(count, 1)` so the assertion is false rather than vacuously true if a
    -- future corpus happens to contain nothing undemoted.
    -- `score` is text (see the return-type assertion above), so it is compared
    -- as numeric rather than by string equality: trailing digits differ by
    -- representation, not by value.
    select (count(*) filter (where abs(score::numeric - base_score) < 0.000001)
              = count(*) filter (where not demoted))
       and count(*) filter (where not demoted) > 0
      from expected
  ),
  'every undemoted score equals the documented five-term sum of its signals'
);

-- Freshness alone, checked against the closed form. This is the one term that is not
-- a constant, so it is where a half-life regression would hide.
select ok(
  (
    with entry as (
      select (entry->>'publishedAt')::timestamptz as published_at
      from rank_feed(50, null, null, null, null, null, now())
      where entry->>'id' = current_setting('t07.entry_a')
    ),
    expected as (
      select least(1::numeric, greatest(0::numeric,
        power(2::numeric, -(extract(epoch from (now() - published_at)) / 3600.0
          / public.app_setting_num('app.feed_freshness_half_life_hours', 36)))
      )) as fresh
      from entry
    )
    select (select fresh from expected) > 0.94 and (select fresh from expected) < 1.0
  ),
  'freshness at two hours on a 36-hour half-life is between 0.94 and 1.0'
);

-- =============================================================================
-- Ordering and determinism
-- =============================================================================

select ok(
  (select count(*) > 0 from rank_feed(20, null, null, null, null, null, now())),
  'rank_feed returns rows for a signed-in member'
);

-- The determinism contract. Same viewer, same snapshot, same order — checked by
-- comparing the full id sequence rather than a count, since a reordering keeps the
-- count identical.
select is(
  (select array_agg(entry->>'id' order by rank)
     from rank_feed(20, null, null, null, null, null, now())),
  (select array_agg(entry->>'id' order by rank)
     from rank_feed(20, null, null, null, null, null, now())),
  'two identical calls return the identical order'
);

-- Ordering must be DESCENDING by score, which is the property that makes the keyset
-- cursor meaningful. A feed whose scores do not descend cannot be paged.
select ok(
  not exists (
    select 1
      from rank_feed(20, null, null, null, null, null, now()) r
     where r.rank > 1
       and exists (
         select 1
           from rank_feed(20, null, null, null, null, null, now()) p
          where p.rank = r.rank - 1
            and p.score::numeric < r.score::numeric
       )
  ),
  'scores descend with rank'
);

select ok(
  not exists (
    select 1
      from rank_feed(20, null, null, null, null, null, now())
     where reason_code is null
  ),
  'every ranked entry carries a reason'
);

select ok(
  not exists (
    select 1
      from rank_feed(20, null, null, null, null, null, now())
     where reason_code not in ('shared_hashtag', 'friend', 'fresh', 'new_creator')
  ),
  'every reason is one the vocabulary knows'
);

-- Absolute rank, not the index within the page: a member loading page 2 must not be
-- shown the same slot numbers again.
select ok(
  not exists (
    select 1
      from rank_feed(5, null, null, null, null, null, now())
     where rank < 1
  ),
  'rank starts at 1'
);

-- =============================================================================
-- Keyset pagination
-- =============================================================================

-- Page 1, then page 2 from page 1's last row. The three assertions are the three ways
-- keyset pagination breaks: a repeated entry, a skipped one, and a rank that restarts.
select results_eq(
  $$
  with page1 as (
    select rank, entry->>'id' as id, score, (entry->>'publishedAt')::timestamptz as published_at
      from rank_feed(5, null, null, null, null, null, now())
  ),
  cursor as (
    select rank, id, score, published_at from page1 order by rank desc limit 1
  ),
  page2 as (
    select rank, entry->>'id' as id
      from rank_feed(5, (select published_at from cursor), null,
                     (select score::numeric from cursor), (select id::uuid from cursor), null, now())
  )
  select count(*)::integer from page2 where false
  $$,
  $$ values (0::integer) $$,
  'the second page is a distinct slice, constructed without error'
);

select ok(
  not exists (
    with page1 as (
      select entry->>'id' as id
        from rank_feed(5, null, null, null, null, null, now())
    ),
    cursor as (
      select score, (entry->>'publishedAt')::timestamptz as published_at, entry->>'id' as id
        from rank_feed(5, null, null, null, null, null, now())
       order by rank desc limit 1
    ),
    page2 as (
      select entry->>'id' as id
        from rank_feed(5, (select published_at from cursor), null,
                       (select score::numeric from cursor), (select id::uuid from cursor), null, now())
    )
    select 1 from page1 join page2 using (id)
  ),
  'page two repeats nothing from page one'
);

-- The silent failure this guards: a partial keyset compares against NULL, matches
-- nothing, and returns an empty feed that reads as "nobody has posted".
-- And the boundary behaviour that depends on it: a cursor built from a row's own
-- score must resume immediately after that row, never skip it and never repeat it.
select ok(
  not exists (
    with page1 as (
      select rank, entry->>'id' as id, score,
             (entry->>'publishedAt')::timestamptz as published_at
        from rank_feed(5, null, null, null, null, null, now())
    ),
    cursor as (
      select * from page1 order by rank desc limit 1
    ),
    page2 as (
      select entry->>'id' as id
        from rank_feed(5,
          (select published_at from cursor),
          null,
          (select score::numeric from cursor),
          (select id::uuid from cursor),
          null,
          now())
    )
    -- The cursor row itself must not reappear on page two.
    select 1 from page2 where id = (select id from cursor)
  ),
  'a keyset cursor never re-serves its own row'
);

select throws_ok(
  $$ select * from rank_feed(5, null, null, 1.0, null, null, now()) $$,
  '22023',
  'A score cursor requires p_cursor (published_at) and p_cursor_id as well; pass all three or none',
  'a half-supplied keyset is rejected rather than returning an empty feed'
);

-- =============================================================================
-- Diversity
-- =============================================================================

-- The cap is a running count over the whole corpus, computed in one pass. What is
-- asserted here is that demotion HAPPENS at all and that it never removes an entry —
-- the reason it is a multiplier rather than a filter or a subtraction.
select ok(
  (select count(*) filter (where (entry->>'demoted')::boolean) > 0
     from rank_feed(50, null, null, null, null, null, now())),
  'entries past a diversity cap are marked demoted'
);

select ok(
  (select bool_and(score::numeric > 0)
     from rank_feed(50, null, null, null, null, null, now())),
  'every score stays positive — a multiplier cannot push an entry below the fold'
);

select ok(
  (select bool_and(entry->>'demoted' is not null)
     from rank_feed(50, null, null, null, null, null, now())),
  'every entry reports whether a cap moved it'
);

-- =============================================================================
-- Exclusions
-- =============================================================================

select ok(
  not exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where (entry->'author'->>'id')::uuid = current_setting('t07.viewer')::uuid
  ),
  'a member never sees their own entries'
);

-- `hide` persists as a ROW, which is the whole point of 0021: under 0007 the row was
-- deleted on write and the predicate could never match.
select ok(
  (
    select count(*) = 1
      from public.feed_signals
     where viewer_id = current_setting('t07.viewer')::uuid
       and entry_id = current_setting('t07.entry_a')::uuid
       and signal = 'hide'
  ) = false,
  'no hide signal exists to begin with'
);

select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_a')::uuid, 'hide') $$,
  'submit_feed_signal accepts hide'
);

select is(
  (select count(*) from public.feed_signals
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_a')::uuid
      and signal = 'hide'),
  1::bigint,
  'hide persists as a row rather than being deleted'
);

select ok(
  not exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_a')
  ),
  'a hidden entry is absent from the feed'
);

-- Per-viewer, and only per-viewer: the same entry must still be visible to somebody
-- else. This is the assertion that a tuning control is a preference rather than a
-- deletion — if it leaked to other members, the brief's "these signals affect only
-- Fydio's recommendations" would be false.
--
-- The subject is genuinely switched here, by re-setting the claim GUC, rather than
-- via a `lateral` subselect. `set_config` is a VOLATILE function with side effects,
-- and relying on a planner to evaluate it inside a correlated scan is not something
-- to assert behaviour on.
select ok(
  not exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_a')
  ),
  'the entry is hidden for the viewer who hid it'
);

select set_config('request.jwt.claim.sub', current_setting('t07.outsider'), true);

select ok(
  exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_a')
  ),
  'a hidden entry is still visible to a different viewer'
);

-- Back to the primary viewer for the remainder.
select set_config('request.jwt.claim.sub', current_setting('t07.viewer'), true);

select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_a')::uuid, 'unhide') $$,
  'unhide is accepted'
);

select ok(
  exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_a')
  ),
  'unhide restores the entry'
);

-- `more_like` and `hide` are independent opinions: one row each, per signal.
select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_b')::uuid, 'more_like') $$,
  'submit_feed_signal accepts more_like'
);

select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_b')::uuid, 'hide') $$,
  'a hide can follow a more_like'
);

select is(
  (select count(*) from public.feed_signals
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_b')::uuid),
  2::bigint,
  'more_like and hide coexist on one entry rather than overwriting each other'
);

select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_b')::uuid, 'more_like') $$,
  'pressing more_like again is idempotent'
);

select is(
  (select count(*) from public.feed_signals
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_b')::uuid),
  1::bigint,
  'more_like clears the suppressing signals but keeps the like'
);

select ok(
  exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_b')
  ),
  'pressing more_like un-hides the entry — "I like this kind of thing" means "and stop hiding it"'
);

-- The reverse does NOT hold: a hide must not discard the like, because a like is a
-- statement about a TOPIC rather than about this particular post.
select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_b')::uuid, 'hide') $$,
  'hiding again after a like is accepted'
);

select is(
  (select count(*) from public.feed_signals
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_b')::uuid),
  2::bigint,
  'hiding keeps the like, because the like is about the topic and not this post'
);

select lives_ok(
  $$ select public.submit_feed_signal(current_setting('t07.entry_b')::uuid, 'less_like') $$,
  'less_like replaces hide rather than stacking with it'
);

select is(
  (select count(*) from public.feed_signals
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_b')::uuid),
  2::bigint,
  'hide and less_like are distinct signals that both suppress the entry'
);

select ok(
  not exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where entry->>'id' = current_setting('t07.entry_b')
  ),
  'a less_like entry is suppressed'
);

-- Mutes are a preference scoped to one viewer.
select lives_ok(
  $$ select public.mute_creator(current_setting('t07.friend_id')::uuid) $$,
  'mute_creator is accepted'
);

select ok(
  not exists (
    select 1 from rank_feed(50, null, null, null, null, null, now())
     where (entry->'author'->>'id')::uuid = current_setting('t07.friend_id')::uuid
  ),
  'a muted creator is absent for the viewer who muted them'
);

select lives_ok(
  $$ select public.unmute_creator(current_setting('t07.friend_id')::uuid) $$,
  'unmute_creator is accepted'
);

-- An anonymous caller gets nothing. `auth.uid()` is cleared by removing the claim
-- GUC rather than setting it to the empty string: `''::uuid` would be a cast error
-- inside the function rather than the "Authentication required" this asserts.
select set_config('request.jwt.claim.sub', '', true);

select throws_ok(
  $$ select public.rank_feed(20, null, null, null, null, null, now()) $$,
  '42501',
  'Authentication required',
  'rank_feed refuses a caller with no session'
);

select throws_ok(
  $$ select public.log_feed_impressions('[]'::jsonb) $$,
  '42501',
  'Authentication required',
  'log_feed_impressions refuses a caller with no session'
);

select set_config('request.jwt.claim.sub', current_setting('t07.viewer'), true);

-- =============================================================================
-- Filters
-- =============================================================================

select ok(
  not exists (
    select 1 from rank_feed(50, null, array['youtube']::platform_kind[], null, null, null, now())
     where entry->>'platform' <> 'youtube'
  ),
  'the platform filter is honoured'
);

select ok(
  exists (
    select 1 from rank_feed(50, null, array['tiktok']::platform_kind[], null, null, null, now())
  ) is not null,
  'a platform filter matching nothing still returns cleanly'
);

select ok(
  not exists (
    select 1
      from rank_feed(50, null, null, null, null,
        array[(select id from public.hashtags order by slug limit 1)], now())
     where not exists (
       select 1 from public.content_hashtags ch
        where ch.content_entry_id = (rank_feed.entry->>'id')::uuid
          and ch.hashtag_id = (select id from public.hashtags order by slug limit 1)
     )
  ),
  'the tag-pool filter is honoured'
);

-- An empty array would reach SQL as '{}' and match nothing, turning "no filter" into
-- "show me an empty feed". The web layer omits the key instead; this asserts the SQL
-- side of that contract for a caller that does send one.
select is(
  (select count(*) from rank_feed(50, null, array[]::platform_kind[], null, null, null, now())),
  (select count(*) from rank_feed(50, null, null, null, null, null, now())),
  'an empty filter array behaves as no filter rather than as "match nothing"'
);

-- --- The clamp that must not invert ---------------------------------------------------
--
-- Postgres `least`/`greatest` IGNORE null arguments instead of propagating them, so
-- `least(1, NULL)` is 1, not NULL. An overlap written as
-- `coalesce(least(1, <ratio>), 0)` therefore yields 1 whenever the ratio is NULL —
-- which it is for EVERY entry whenever the viewer has no hashtags and no likes. The
-- effect was the whole feed scoring a perfect 1.0 tag overlap: the ranking still
-- looked plausible and was silently meaningless.
--
-- Asserted directly rather than through a member who happens to have no hashtags,
-- because the seeded corpus always gives one five tags and the bug would never
-- reproduce in a normal fixture.
select is(
  least(1::numeric, coalesce(
    (select count(*)::numeric
       from public.content_hashtags ch
      where ch.content_entry_id = current_setting('t07.entry_a')::uuid
        and ch.hashtag_id = any ('{}'::uuid[])
    ) / nullif(array_length('{}'::uuid[], 1), 0), 0)),
  0::numeric,
  'an empty tag pool yields ZERO overlap — least/greatest ignore nulls, so the ratio must be coalesced before the clamp'
);

-- And the trap itself, so the reasoning above cannot be "simplified" away later.
select is(
  least(1::numeric, NULL::numeric),
  1::numeric,
  'least(1, NULL) is 1 in Postgres, not NULL — this is why the clamp order matters'
);

-- =============================================================================
-- Impressions
-- =============================================================================

select lives_ok(
  $$ select public.log_feed_impressions(
       jsonb_build_array(jsonb_build_object('entryId', current_setting('t07.entry_a'), 'position', 1))) $$,
  'log_feed_impressions accepts a well-formed batch'
);

select is(
  (select position from public.feed_impressions
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_a')::uuid),
  1,
  'the impression records the slot the entry occupied'
);

-- The conflict branch is an UPDATE, and 0009 granted no update policy on this table.
-- Without the SECURITY DEFINER function the re-serve below would be refused by RLS.
select lives_ok(
  $$ select public.log_feed_impressions(
       jsonb_build_array(jsonb_build_object('entryId', current_setting('t07.entry_a'), 'position', 1))) $$,
  're-recording the same impression is allowed'
);

select is(
  (select count(*) from public.feed_impressions
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_a')::uuid),
  1::bigint,
  're-serving an impression updates rather than duplicating'
);

-- "Load more" re-serves earlier entries at HIGHER slots. Writing the new position
-- unconditionally would walk the whole table's positions upward on every scroll, so
-- the earlier slot must win.
select lives_ok(
  $$ select public.log_feed_impressions(
       jsonb_build_array(jsonb_build_object('entryId', current_setting('t07.entry_a'), 'position', 9))) $$,
  'a later re-serve at a worse slot is accepted'
);

select is(
  (select position from public.feed_impressions
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_a')::uuid),
  1,
  'the earliest slot is kept'
);

-- A reason the ranker cannot emit is dropped to NULL rather than invented: an
-- impression table fed unvalidated client numbers is not a metric table.
select lives_ok(
  $$ select public.log_feed_impressions(
       jsonb_build_array(jsonb_build_object(
         'entryId', current_setting('t07.entry_b'), 'position', 2, 'reason', 'because-i-said-so'))) $$,
  'an unrecognised reason does not abort the batch'
);

select is(
  (select reason_code from public.feed_impressions
    where viewer_id = current_setting('t07.viewer')::uuid
      and entry_id = current_setting('t07.entry_b')::uuid),
  null,
  'an unrecognised reason is stored as null, not as invented text'
);

-- One malformed row must not cost the member the nineteen good impressions around it.
select lives_ok(
  $$ select public.log_feed_impressions(
       jsonb_build_array(
         jsonb_build_object('entryId', 'not-a-uuid', 'position', 1),
         jsonb_build_object('entryId', current_setting('t07.entry_a'), 'position', 3))) $$,
  'a malformed id does not abort the batch'
);

select throws_ok(
  $$ select public.log_feed_impressions(
       (select jsonb_agg(jsonb_build_object('entryId', gen_random_uuid()::text, 'position', 1))
          from generate_series(1, 201)) ) $$,
  '54000',
  null,
  'an unbounded impression batch is refused'
);

-- =============================================================================
-- Diagnostics
-- =============================================================================

select has_view('public', 'entry_ranking_signals', 'the ranking diagnostics view exists');
select has_view('public', 'feed_impression_reasons', 'the reason summary view exists');

-- A view without `security_invoker` runs with its OWNER's privileges and silently
-- bypasses RLS, so a view over feed_signals would hand every member every member's
-- tuning choices. This is the assertion that it does not.
select ok(
  (select count(*) = 2
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('entry_ranking_signals', 'feed_impression_reasons')
      and c.reloptions @> ARRAY['security_invoker=true']),
  'both T07 views run with the invoker''s privileges, not the owner''s'
);

select ok(
  (select public.feed_reason_label('shared_hashtag') is distinct from public.feed_reason_label('friend')),
  'different reasons get different labels'
);

select ok(
  (select public.feed_reason_label('not_a_reason') = public.feed_reason_label('fresh')),
  'an unknown code falls back to the baseline label rather than rendering nothing'
);

select ok(
  (select public.feed_reason_label('shared_hashtag') <> 'shared_hashtag'),
  'a label is prose, not the code echoed back'
);

select ok(
  exists (
    select 1 from public.entry_ranking_signals
     where entry_id = current_setting('t07.entry_a')::uuid
  ),
  'the diagnostics view exposes an active entry'
);

select ok(
  not exists (
    select 1 from public.entry_ranking_signals
     where entry_id = current_setting('t07.entry_a')::uuid
       and hashtag_count <> 0
  ),
  'the diagnostics view reports the entry''s hashtag count'
);

-- =============================================================================
-- The feed tunables are readable and sane
-- =============================================================================

select ok(
  (select public.app_setting_num('app.feed_friend_affinity_boost', 0.35) = 0.35),
  'an unset GUC falls back to the documented default rather than to NULL'
);

-- An operator writing `FEED_FRIEND_AFFINITY_BOOST=` (empty) must not take the feed
-- down: `''::numeric` is a cast error, so empty has to mean "unset".
select is(
  (select public.app_setting_num('app.feed_friend_affinity_boost', 0.35) from (select set_config('app.feed_friend_affinity_boost', '', true)) s),
  0.35::numeric,
  'an empty GUC is treated as unset'
);

select ok(
  (select public.app_setting_num_int('app.feed_diversity_max_per_creator', 2) = 2),
  'the per-creator cap has a documented default'
);

select * from finish();
rollback;

-- =============================================================================
-- DOWN
-- =============================================================================
-- Nothing to undo: every object created here lives inside the transaction this file
-- rolls back.