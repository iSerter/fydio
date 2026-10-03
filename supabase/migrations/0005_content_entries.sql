-- =============================================================================
-- T02 · 0005 — Content entries
-- =============================================================================
--
-- Submitted public content, and the function that spends a Credit to publish it.
--
-- An entry carries EXACTLY three hashtags — not "up to three". The brief is
-- explicit, and the difference matters for the feed: with a variable count, three
-- well-matched tags and one loosely-related tag would rank differently purely by
-- how many the author happened to add. A fixed count makes the tag-match ratio
-- comparable across entries.

create table public.content_entries (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,

  platform platform_kind not null,
  original_url text not null,
  canonical_url text not null,

  -- SHA-256 of the lowercase canonical URL. Storing a hash rather than relying on
  -- a unique index over the URL text keeps duplicate detection working even when
  -- the platform has redirected through several equivalent spellings.
  url_hash bytea not null,

  title text,
  caption_excerpt text,
  thumbnail_path text,
  thumbnail_source text,

  -- `pending` until the T04 resolver has had a chance; `unavailable` when the
  -- platform simply does not permit a preview and a link card is shown instead.
  preview_state preview_state not null default 'pending',
  preview_meta jsonb,

  creator_note text,
  asks_for_feedback boolean not null default false,

  status entry_state not null default 'active',
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint content_entry_url_len check (char_length(original_url) between 4 and 2000),
  constraint content_entry_title_len check (title is null or char_length(title) <= 300),
  -- The excerpt is a preview, not a mirror of the post. Bounded here so a member
  -- cannot paste an entire transcript into a field meant to show in a feed card.
  constraint content_entry_caption_len check (caption_excerpt is null or char_length(caption_excerpt) <= 1000),
  constraint content_entry_creator_note_len check (creator_note is null or char_length(creator_note) <= 1000),

  -- A removed entry keeps its row so the audit trail and any credit reversal stay
  -- resolvable; the two must agree.
  constraint content_entry_removed_consistent check (
    (status = 'removed' and deleted_at is not null) or
    (status <> 'removed')
  ),

  -- One submission of one URL per author. Community-wide duplicates are allowed:
  -- two people can legitimately share the same post.
  unique (author_id, url_hash)
);

create index content_entries_author_idx on public.content_entries (author_id, created_at desc);

-- --- content_hashtags: exactly three -------------------------------------------

create table public.content_hashtags (
  content_entry_id uuid not null references public.content_entries (id) on delete cascade,
  hashtag_id uuid not null references public.hashtags (id) on delete cascade,
  position smallint not null,

  primary key (content_entry_id, hashtag_id),

  constraint entry_hashtag_position_range check (position between 0 and 2)
);

create index content_hashtags_hashtag_idx on public.content_hashtags (hashtag_id);

-- THE EXACTLY-THREE RULE. Deferred to COMMIT for the same reason the five-tag
-- profile rule is (0002): the meaningful count is the transaction's settled
-- total, and `create_content_entry` legitimately adds all three in one
-- statement. A BEFORE trigger cannot see the rows its own transaction has not
-- inserted yet, so checking there would reject every valid submission.
create or replace function public.enforce_entry_hashtag_count()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cnt integer;
begin
  select count(*) into cnt
    from public.content_hashtags
   where content_entry_id = new.content_entry_id;

  if cnt != 3 then
    raise exception 'Content entry must have exactly 3 hashtags, found %', cnt
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create constraint trigger entry_hashtag_count_trg
  after insert or update on public.content_hashtags
  deferrable initially deferred
  for each row execute function public.enforce_entry_hashtag_count();

-- =============================================================================
-- create_content_entry — the atomic spend
-- =============================================================================
--
-- This is the function the whole credit economy turns on, so it is worth being
-- explicit about the ordering. Everything below happens inside ONE transaction;
-- either the entry exists and the Credit is gone, or neither happened.
--
-- THE ADVISORY LOCK IS NOT OPTIONAL. Two rapid clicks produce two overlapping
-- transactions. Both read the balance, both see 1 Credit, both conclude they can
-- afford it, and both insert — spending a Credit that does not exist. The failure
-- is silent and the ledger no longer balances against the entries.
-- `pg_advisory_xact_lock` serialises submissions per user: the second transaction
-- blocks at the lock until the first commits, then re-reads the balance and sees
-- 0. The lock is keyed on the user, so unrelated members never contend, and it is
-- transaction-scoped, so it releases itself on commit or rollback with no cleanup
-- path to get wrong.
--
-- NOTE ON PARAMETER DEFAULTS: every parameter after the first defaulted one must
-- itself have a default — Postgres rejects the signature otherwise. That is why
-- `p_hashtags` carries `default '{}'` here even though it is required in practice;
-- the check below rejects an empty array with a clear message rather than the
-- database rejecting the call shape.

create or replace function public.create_content_entry(
  p_platform          platform_kind,
  p_url               text,
  p_canonical_url     text,
  p_hashtags          uuid[] default '{}',
  p_title             text default null,
  p_caption           text default null,
  p_creator_note      text default null,
  p_asks_for_feedback boolean default false,
  p_cover_path        text default null
) returns public.content_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_cost    integer := public.app_setting_int('app.credit_submission_cost', 1);
  v_grace   integer := public.app_setting_int('app.new_member_grace_days', 14);
  v_ncap    integer := public.app_setting_int('app.new_member_submission_cap', 3);
  v_balance integer;
  v_hash    bytea := extensions.digest(lower(p_canonical_url), 'sha256');
  v_entry   public.content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Exactly three DISTINCT hashtags. Distinct as well as counted: the same tag
  -- listed twice is not two tags, and letting it through would let an entry claim
  -- three positions while matching on one.
  if coalesce(array_length(p_hashtags, 1), 0) <> 3
     or (select count(distinct h) from unnest(p_hashtags) h) <> 3 then
    raise exception 'Exactly three distinct hashtags are required'
      using errcode = 'check_violation';
  end if;

  -- Every tag must already exist in the shared vocabulary. Creating tags on the
  -- fly here would let one member fragment the pool with near-duplicates.
  if exists (
    select 1 from unnest(p_hashtags) h
     where not exists (select 1 from public.hashtags where id = h)
  ) then
    raise exception 'Unknown hashtag' using errcode = 'foreign_key_violation';
  end if;

  -- A member who has been blocked by someone else does not submit into the
  -- community feed at all. Only the "I was blocked" direction is refused here:
  -- the other direction is a normal state between two members who are simply not
  -- connected, and refusing it would block every non-friend.
  if exists (
    select 1 from public.friendships f
     where f.state = 'blocked'
       and f.addressee_id = v_uid
  ) then
    raise exception 'Blocked account' using errcode = 'insufficient_privilege';
  end if;

  -- New-member submission rate cap (abuse control, brief §9). Only applies inside
  -- the grace window, so an established member is not throttled by a rule meant
  -- to blunt a burst of submissions from a fresh account.
  if now() < (select created_at + make_interval(days => v_grace) from public.profiles where id = v_uid)
     and (select count(*) from public.content_entries
           where author_id = v_uid and created_at > now() - interval '24 hours') >= v_ncap then
    raise exception 'Submission rate limit reached for new members'
      using errcode = 'check_violation';
  end if;

  -- Duplicate URL guard per author.
  if exists (
    select 1 from public.content_entries where author_id = v_uid and url_hash = v_hash
  ) then
    raise exception 'You have already submitted this URL' using errcode = 'unique_violation';
  end if;

  -- ATOMIC SPEND. The lock is taken BEFORE the balance read, not after: locking
  -- afterwards would let both transactions read the same balance and only then
  -- queue, which defeats the point entirely.
  perform pg_advisory_xact_lock(hashtext(v_uid::text));

  select coalesce(sum(delta), 0)::integer into v_balance
    from public.credit_ledger
   where user_id = v_uid
     and status in ('available', 'spent');

  if v_balance < v_cost then
    raise exception 'Insufficient Credits: need %, have %', v_cost, v_balance
      using errcode = 'check_violation';
  end if;

  -- `spent`, not `available`: this row is what actually subtracts. See the balance
  -- formula at the top of 0004 — a spend recorded as `available` would never be
  -- summed and the balance would never fall.
  insert into public.credit_ledger (user_id, delta, kind, status, note)
  values (v_uid, -v_cost, 'submission_spend', 'spent', 'Content submission');

  insert into public.content_entries (
    author_id, platform, original_url, canonical_url, url_hash,
    title, caption_excerpt, thumbnail_path, creator_note,
    asks_for_feedback, status, published_at
  ) values (
    v_uid, p_platform, p_url, p_canonical_url, v_hash,
    left(coalesce(p_title, ''), 300), left(coalesce(p_caption, ''), 1000),
    p_cover_path, left(coalesce(p_creator_note, ''), 1000),
    p_asks_for_feedback, 'active', now()
  ) returning * into v_entry;

  insert into public.content_hashtags (content_entry_id, hashtag_id, position)
  select v_entry.id, h, ord - 1
    from unnest(p_hashtags) with ordinality as t(h, ord);

  return v_entry;
end;
$$;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.create_content_entry(platform_kind, text, text, uuid[], text, text, text, boolean, text);
-- drop table if exists public.content_hashtags;
-- drop table if exists public.content_entries;
