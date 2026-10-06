-- =============================================================================
-- T07 · 0021 — Feed signals that actually persist
-- =============================================================================
--
-- 0007 shipped `submit_feed_signal` with a rule that made half of T07 impossible:
--
--   -- 'hide' removes the signal row entirely: a hidden item is an absence from the
--   -- feed, not a stored negative preference that has to be re-applied forever.
--
-- The reasoning is sound in isolation and wrong in the presence of a ranker, because
-- `rank_feed` reads the ABSENCE of a `hide` row as permission to show the entry.
-- Deleting the row is indistinguishable from never having hidden anything, so the
-- control did nothing at all. It was untestable precisely because there was nothing
-- to test: with the row deleted, no query could distinguish a hidden entry from an
-- unhide one.
--
-- 0020's `not exists (... signal in ('hide', 'less_like'))` is correct SQL against a
-- table that can hold those values. This migration makes that possible.
--
-- THE CONSTRAINT HAS TO GO TOO. `unique (viewer_id, entry_id)` means one row per
-- pair, so `more_like` and `hide` cannot coexist — and pressing "hide" after "more
-- like this" would have to silently discard one of them. Per-signal uniqueness
-- (`viewer_id, entry_id, signal`) is what the product actually means: distinct,
-- independent opinions about a distinct entry, last write winning.

alter table public.feed_signals
  drop constraint if exists feed_signals_viewer_id_entry_id_key;

alter table public.feed_signals
  drop constraint if exists feed_signals_viewer_entry_id_signal_key;

alter table public.feed_signals
  add constraint feed_signals_viewer_entry_id_signal_key
  unique (viewer_id, entry_id, signal);

-- --- submit_feed_signal ---------------------------------------------------------------
--
-- `unhide` is a first-class verb rather than a delete, so "hide" stays reversible
-- through the same path that set it and the audit trail keeps the record of what was
-- suppressed. It is NOT an enum value: it names the absence of a signal, and a
-- fourth `feed_signal_kind` would put a non-signal in a column of signals.
--
-- VALIDATION BEFORE WRITE. Without the existence check a member could accumulate
-- signals against arbitrary uuids, which is harmless today and a stored-garbage
-- problem the moment anything aggregates that table. The author-may-see-own-entry
-- clause exists because the entry detail page lets an author act on their own post;
-- a signal against an entry nobody can see is not a meaningful opinion.

create or replace function public.submit_feed_signal(p_entry_id uuid, p_signal text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Clears BOTH suppressing signals, not just `hide`. A member who hid something and
  -- then pressed "less like this" wants it back for the same reason, and making them
  -- remember which of the two verbs applies is a worse interface than one reset.
  if p_signal = 'unhide' then
    delete from public.feed_signals
     where viewer_id = auth.uid()
       and entry_id = p_entry_id
       and signal in ('hide', 'less_like');
    return;
  end if;

  if p_signal not in ('more_like', 'less_like', 'hide') then
    raise exception 'Unknown feed signal: %', p_signal using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
      from public.content_entries e
     where e.id = p_entry_id
       and (e.author_id = auth.uid() or e.status = 'active')
  ) then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  -- Entry-level suppression is a SINGLE SLOT. Pressing `more_like` or `less_like`
  -- clears whatever was suppressing this entry first.
  --
  -- `less_like` replacing `hide` matters as much as `more_like` doing so: both mean
  -- "do not show me this again", and keeping both would leave the ranker with two
  -- rows saying the same thing and an "unhide" that has to know about both. The
  -- difference between the two verbs is the WORD the member used, which is worth
  -- preserving in the UI but not worth storing twice.
  --
  -- The like itself is never cleared by a suppression. A like is a statement about a
  -- topic rather than about this particular post, so hiding this entry while still
  -- wanting more like it is a coherent thing to want.
  if p_signal in ('more_like', 'less_like') then
    delete from public.feed_signals
     where viewer_id = auth.uid()
       and entry_id = p_entry_id
       and signal in ('hide', 'less_like');
  end if;

  insert into public.feed_signals (viewer_id, entry_id, signal)
  values (auth.uid(), p_entry_id, p_signal::feed_signal_kind)
  on conflict (viewer_id, entry_id, signal) do update
    set created_at = now();
end;
$$;

comment on function public.submit_feed_signal(uuid, text) is
  'Records a feed tuning signal. hide/less_like exclude the entry from this viewer''s feed (see rank_feed); more_like boosts entries sharing the entry''s hashtags. Pass ''unhide'' to clear the suppressing signals.';

-- --- log_feed_impressions --------------------------------------------------------------
--
-- The task text has the web app upsert `feed_impressions` directly. That cannot work:
-- 0009 granted `insert` and `select` on that table but no `update`, so the conflict
-- branch of an upsert — which is an UPDATE — is refused by RLS the second time the
-- same entry is served. A member scrolling back up and down a page would silently
-- stop refreshing their impressions, and nothing would report the error.
--
-- Two options: add an `update` policy, or route the write through a function. The
-- function is chosen because the write has rules that belong next to the ranking
-- rather than next to the observer that calls it:
--
--   * `position` is the SLOT in the feed, which the client knows and the server does
--     not. It is a parameter rather than something derived here.
--   * `score` and `reason_code` are RELAYED, not asserted. They arrive from the
--     `rank_feed` response the same request is rendering, so they were computed by
--     the ranker a moment earlier — but they cross a client boundary here, and a
--     metric table fed by unvalidated client numbers is not a metric table. So the
--     reason is checked against the vocabulary `ranked_reason` can produce and the
--     score is clamped into `numeric(8,4)`. A value that fails either check is
--     dropped to NULL rather than rejected: refusing the whole batch because one
--     entry was malformed would cost the member the nineteen impressions that were
--     fine, and those are the ones the open-rate metric needs.
--   * A re-served entry must not move its first `served_at`, so the conflict branch
--     touches only `position` and `score`, and takes the EARLIER position. "Load
--     more" re-serves earlier entries at higher slots, so writing the new position
--     unconditionally would walk the whole table's positions upward on every scroll.
--
-- SECURITY DEFINER because the member's own RLS-scoped insert cannot express the
-- conflict branch at all. It reads `auth.uid()` for the viewer rather than accepting
-- one, so a caller cannot record impressions against somebody else.

create or replace function public.log_feed_impressions(
  p_entries jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  item jsonb;
  v_entry_id uuid;
  v_position integer;
  v_score numeric;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_entries is null then
    return;
  end if;

  -- Bounded, because this is called from a viewport observer and an unbounded array
  -- would let one request write an unbounded number of rows. 200 is ten pages of 20,
  -- which is more than any realistic observer batch.
  if jsonb_array_length(p_entries) > 200 then
    raise exception 'Too many impressions in one batch (max 200)'
      using errcode = 'program_limit_exceeded';
  end if;

  for item in select * from jsonb_array_elements(p_entries)
  loop
    -- Each cast is guarded in its own `case` rather than trusting the payload: an
    -- unparsable value makes the cast itself raise, and one malformed row must not
    -- abort the batch around it.
    v_entry_id := case
      when (item ->> 'entryId') ~ '^[0-9a-fA-F-]{36}$' then (item ->> 'entryId')::uuid
      else null
    end;

    v_position := case
      when (item ->> 'position') ~ '^[0-9]+$' then (item ->> 'position')::integer
      else null
    end;

    v_score := case
      when coalesce((item ->> 'score') ~ '^-?[0-9]+(\.[0-9]+)?$', false)
        then greatest(-9999.9999, least(9999.9999, (item ->> 'score')::numeric))
      else null
    end;

    -- The vocabulary `ranked_reason` can emit. Anything else is not a reason Fydio
    -- knows how to explain, so it is stored as NULL rather than invented.
    v_reason := case
      when (item ->> 'reason') in ('shared_hashtag', 'friend', 'fresh', 'new_creator')
        then (item ->> 'reason')
      else null
    end;

    if v_entry_id is null or v_position is null or v_position < 1 then
      continue;
    end if;

    insert into public.feed_impressions (
      entry_id, viewer_id, position, score, reason_code, served_at
    )
    values (v_entry_id, v_uid, v_position, v_score, v_reason, now())
    on conflict (viewer_id, entry_id) do update
      set position = least(public.feed_impressions.position, excluded.position),
          -- `coalesce` so a later re-serve that omits the score does not erase the
          -- one already recorded. `served_at` is deliberately absent: the FIRST
          -- sighting is the fact worth keeping.
          score = coalesce(excluded.score, public.feed_impressions.score),
          reason_code = coalesce(excluded.reason_code, public.feed_impressions.reason_code);
  end loop;
end;
$$;

comment on function public.log_feed_impressions(jsonb) is
  'Records entries the viewer actually saw. [{ "entryId": uuid, "position": int, "score": num, "reason": text }]. Score and reason are clamped and validated here rather than trusted.';

grant execute on function public.log_feed_impressions(jsonb) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.log_feed_impressions(jsonb);
-- (submit_feed_signal reverts to its 0007 body, which deletes on 'hide')
-- alter table public.feed_signals
--   drop constraint if exists feed_signals_viewer_entry_id_signal_key;
-- alter table public.feed_signals
--   add constraint feed_signals_viewer_id_entry_id_key unique (viewer_id, entry_id);