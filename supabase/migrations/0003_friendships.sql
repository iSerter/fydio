-- =============================================================================
-- T02 · 0003 — Friendships
-- =============================================================================
--
-- Mutual connections. A friendship is one row, not two: the requester/addressee
-- pair is normalised into a `pair_key` so that "A and B are connected" can be
-- enforced by a unique index rather than by trusting every writer to check both
-- orderings.
--
-- WHY A GENERATED `pair_key`
-- A-B and B-A are the same friendship. Without a canonical form, two members
-- can each request the other at the same time and end up with two rows that
-- disagree about the state, and `state = 'accepted'` then matches two rows for
-- one pair. `least`/`greatest` gives one deterministic spelling per pair, so
-- the unique index rejects the second request instead. The columns still keep
-- their natural direction (who asked whom) because that is not the same
-- question as "are these two connected".
--
-- `declined` and `blocked` are kept as explicit states rather than deletions.
-- A deletion loses the fact that a request was made and answered, which is
-- exactly what a community of 30 people arguing about moderation needs to be
-- able to see.

create table public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,

  state friendship_state not null default 'pending',

  -- Canonical, order-independent identity of the pair. See header note.
  pair_key text generated always as (
    least(requester_id::text, addressee_id::text) || ':' ||
    greatest(requester_id::text, addressee_id::text)
  ) stored,

  created_at timestamptz not null default now(),
  responded_at timestamptz,

  -- Self-connection is meaningless and would let a member inflate their own
  -- friend count, which is a feed-ranking input. Cheap to forbid here.
  constraint friendship_no_self check (requester_id <> addressee_id),

  -- `responded_at` is set exactly when a state other than 'pending' is.
  -- Enforced rather than trusted so the audit trail cannot claim a pending
  -- request was answered, or vice versa.
  constraint friendship_responded_consistent check (
    (state = 'pending' and responded_at is null) or
    (state <> 'pending' and responded_at is not null)
  )
);

-- The point of `pair_key`: one row per pair, whatever direction it was written.
create unique index friendships_pair_key_idx on public.friendships (pair_key);

-- Directional lookups: "who asked me", "what did I ask for".
create index friendships_requester_idx on public.friendships (requester_id, state);
create index friendships_addressee_idx on public.friendships (addressee_id, state);

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop table if exists public.friendships;