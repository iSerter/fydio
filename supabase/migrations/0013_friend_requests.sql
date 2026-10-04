-- =============================================================================
-- T03 · 0013 — Friendship state machine
-- =============================================================================
--
-- Friend affinity is the only signal in the T07 feed that requires two people to
-- agree. "a transparent, limited boost for confirmed friends" means a connection
-- counts when BOTH members accepted it, so the whole problem is making a
-- half-connection unrepresentable rather than merely discouraged.
--
-- T02 already built the structural half:
--
--   * `friendships.pair_key` -- a stored generated column holding
--     `least(a,b) || ':' || greatest(a,b)`, with a UNIQUE index on it. A-B and B-A
--     collapse to one row, so two members cannot each request the other and end up
--     with two rows disagreeing about state.
--   * `friendship_no_self` and `friendship_responded_consistent` CHECKs.
--   * `friendships_read_involved` -- only the two involved can read the row.
--
-- What is missing is the ALLOWED TRANSITIONS. RLS deliberately refuses most direct
-- writes: `friendships_insert_own` allows an insert whose requester is the caller,
-- and `friendships_update_addressee` allows an update only when the caller is the
-- addressee AND the row is still 'pending'. So the requester cannot accept their own
-- request, and neither party can unilaterally mark a friendship as ended or blocked.
-- That is correct as far as it goes, but it also means the legitimate actions --
-- declining, unfriending, blocking, unblocking -- have no path at all.
--
-- These five SECURITY DEFINER functions are that path. Each one re-checks the
-- transition it is responsible for, so the state machine lives in the database rather
-- than in whichever client happens to call it.
--
-- WHY EVERY FUNCTION IS SECURITY DEFINER
-- `block_member` is the clearest case: a member must be able to block ANYONE,
-- including a member they never exchanged a request with, which means writing a row
-- where they are not necessarily the addressee of a pending request. No RLS policy
-- allows that, and the right answer is a narrow function rather than a broad policy.

-- --- friendship_pair_key(): the canonical pair identity -------------------------
--
-- IMMUTABLE, and byte-for-byte the same expression the `pair_key` generated column
-- uses in 0003. That equality is load-bearing: it is what lets these functions look
-- up a pair with a plain `where pair_key = …` instead of writing the `least`/`greatest`
-- comparison at every call site, where a typo would silently match nothing.

create or replace function public.friendship_pair_key(p_a uuid, p_b uuid)
returns text
language sql
immutable
as $$
  select least(p_a::text, p_b::text) || ':' || greatest(p_a::text, p_b::text);
$$;

-- --- send_friend_request(): none -> pending -------------------------------------
--
-- Idempotent in the sense that matters: asking twice for a connection that already
-- exists reports the existing state instead of creating a second row. The `pair_key`
-- unique index would refuse the insert anyway, but raising a raw constraint violation
-- would surface in the UI as an unexplained error rather than as "you already asked".

create or replace function public.send_friend_request(p_addressee uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_key  text;
  v_row  public.friendships;
  v_cap  integer;
  v_sent integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_addressee is null then
    raise exception 'Pick a member to connect with' using errcode = 'check_violation';
  end if;

  if p_addressee = v_uid then
    raise exception 'You cannot send a friend request to yourself' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.profiles where id = p_addressee) then
    raise exception 'Member not found' using errcode = 'no_data_found';
  end if;

  v_key := public.friendship_pair_key(v_uid, p_addressee);

  -- `for update` so two simultaneous requests cannot both read 'no row' and both
  -- insert; the loser blocks on the unique index instead.
  select * into v_row from public.friendships where pair_key = v_key for update;

  if found then
    -- `pair_key` is order-independent, so this single test covers a block in EITHER
    -- direction. That is what makes a block mutual in effect without duplicating it.
    if v_row.state = 'blocked' then
      raise exception 'Friend requests are not available between these members'
        using errcode = 'check_violation';
    end if;

    if v_row.state = 'accepted' then
      raise exception 'You are already connected' using errcode = 'check_violation';
    end if;

    if v_row.state = 'pending' then
      raise exception 'A request is already pending' using errcode = 'check_violation';
    end if;

    -- Previously declined: allow a fresh ask. Resetting `responded_at` to NULL is
    -- required, not cosmetic -- `friendship_responded_consistent` demands it for a
    -- 'pending' row.
    update public.friendships
       set requester_id = v_uid,
           addressee_id = p_addressee,
           state        = 'pending',
           created_at   = now(),
           responded_at = null
     where id = v_row.id
    returning * into v_row;

    return v_row;
  end if;

  -- Rate limit. A friend request is the one action in Fydio that can be sent at scale
  -- to every member in the directory, so it is capped the way an email would be.
  v_cap := public.app_setting_int('app.friend_request_hourly_cap', 10);

  select count(*) into v_sent
    from public.friendships
   where requester_id = v_uid
     and created_at >= now() - interval '1 hour';

  if v_sent >= v_cap then
    raise exception 'You have sent the maximum number of friend requests for now'
      using errcode = 'check_violation';
  end if;

  insert into public.friendships (requester_id, addressee_id, state)
  values (v_uid, p_addressee, 'pending')
  returning * into v_row;

  return v_row;
end;
$$;

-- --- respond_friend_request(): pending -> accepted | declined -------------------
--
-- The addressee check is the whole point of the function. 0009's
-- `friendships_update_addressee` policy already restricts direct UPDATEs to the
-- addressee of a pending row, but going through SECURITY DEFINER bypasses RLS, so the
-- same rule has to be re-asserted here. It is stated as a distinct check rather than
-- folded into the state test so a requester who calls this gets "only the person who
-- received this request can answer it" instead of a confusing "already answered".

create or replace function public.respond_friend_request(
  p_friendship_id uuid,
  p_accept       boolean
)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.friendships;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row
    from public.friendships
   where id = p_friendship_id
     for update;

  if not found then
    raise exception 'Request not found' using errcode = 'no_data_found';
  end if;

  if v_row.addressee_id <> v_uid then
    raise exception 'Only the person who received this request can answer it'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.state <> 'pending' then
    raise exception 'This request has already been answered' using errcode = 'check_violation';
  end if;

  -- One row, one state change. Because `pair_key` is order-independent there is no
  -- second row to insert for the other direction: accepting IS the mutual record.
  --
  -- The `::friendship_state` cast is required, not decoration: a bare CASE over two
  -- string literals resolves to `text`, and Postgres refuses to assign `text` to an
  -- enum column. Without it the function fails at runtime for every accept.
  update public.friendships
     set state        = (case when p_accept then 'accepted' else 'declined' end)::friendship_state,
         responded_at = now()
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- --- remove_friend(): accepted -> none (audit row retained) ---------------------
--
-- Deliberately NOT a delete. A deletion loses the fact that a request was made and
-- answered, which is exactly what a community of 30 people arguing about moderation
-- needs to be able to see. The row moves to 'declined', which reads as "there was a
-- connection, and it ended" without claiming a request was ever turned down.

create or replace function public.remove_friend(p_friendship_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.friendships;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row
    from public.friendships
   where id = p_friendship_id
     for update;

  if not found then
    raise exception 'Connection not found' using errcode = 'no_data_found';
  end if;

  -- Either party may end a mutual connection. The `in` comparison is on the two id
  -- columns rather than `pair_key = friendship_pair_key(...)` because the row is
  -- already identified by id; this only asks "was I one of the two?".
  if v_row.requester_id <> v_uid and v_row.addressee_id <> v_uid then
    raise exception 'That connection is not yours to remove'
      using errcode = 'insufficient_privilege';
  end if;

  if v_row.state <> 'accepted' then
    raise exception 'Only an accepted connection can be removed' using errcode = 'check_violation';
  end if;

  update public.friendships
     set state        = 'declined',
         responded_at = now()
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- --- block_member(): any -> blocked ---------------------------------------------
--
-- Blocking OVERWRITES whatever state the pair was in, including an accepted
-- friendship. The alternative -- keeping the friendship and recording the block
-- separately -- would leave `state = 'accepted'` still true, and T07's friend-affinity
-- boost reads exactly that, so a blocked pair would keep earning a ranking boost.
-- One row, one state, means a block cannot be forgotten by a query that forgot to
-- check for it.
--
-- The `mutes` row is what removes the blocked member's entries from the blocker FEED.
-- It is written here rather than left to the app because "blocked" and "hidden from my
-- feed" are the same user-visible promise, and a client that updated one without the
-- other would leave a member reading entries from someone they blocked.

create or replace function public.block_member(p_user_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_row public.friendships;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id is null then
    raise exception 'Pick a member to block' using errcode = 'check_violation';
  end if;

  if p_user_id = v_uid then
    raise exception 'You cannot block yourself' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Member not found' using errcode = 'no_data_found';
  end if;

  v_key := public.friendship_pair_key(v_uid, p_user_id);

  update public.friendships
     set state        = 'blocked',
         responded_at = now()
   where pair_key = v_key
  returning * into v_row;

  -- No row yet: the first block between these two creates the record. `requester_id`
  -- is the blocker by convention -- it is the actor, and it keeps the column's meaning
  -- ("who initiated") intact for the audit trail.
  if v_row.id is null then
    insert into public.friendships (requester_id, addressee_id, state, responded_at)
    values (v_uid, p_user_id, 'blocked', now())
    returning * into v_row;
  end if;

  insert into public.mutes (viewer_id, muted_profile_id)
  values (v_uid, p_user_id)
  on conflict do nothing;

  return v_row;
end;
$$;

-- --- unblock_member(): blocked -> none ------------------------------------------
--
-- Lands on 'declined' rather than deleting, matching `remove_friend`: the audit trail
-- keeps the fact that a block happened without leaving the row in a state that any
-- "is this pair blocked?" query would keep matching.

create or replace function public.unblock_member(p_user_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_row public.friendships;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id is null then
    raise exception 'Pick a member' using errcode = 'check_violation';
  end if;

  v_key := public.friendship_pair_key(v_uid, p_user_id);

  update public.friendships
     set state        = 'declined',
         responded_at = now()
   where pair_key = v_key
     and state = 'blocked'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'That member is not blocked' using errcode = 'check_violation';
  end if;

  -- Only the blocker's own mute is lifted. The other direction is a separate block with
  -- a separate row, and unblocking one must never clear the other -- otherwise a member
  -- blocked by two people would appear to be free of one of them.
  delete from public.mutes
   where viewer_id = v_uid
     and muted_profile_id = p_user_id;

  return v_row;
end;
$$;

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Same discipline as 0012 and for the same documented reason (see 0009): this image's
-- `alter default privileges` hands every new function to `anon` and `authenticated` at
-- CREATE time, so a missing revoke is not "not granted", it is "granted to everyone".
--
-- `friendship_pair_key` is a pure function of its two arguments -- it reads no table and
-- returns nothing sensitive -- so it stays available to `anon`; it is only ever useful
-- for constructing a lookup key, and hiding it would gain nothing.

revoke execute on function public.friendship_pair_key(uuid, uuid) from public;

revoke execute on function public.send_friend_request(uuid) from public;
revoke execute on function public.send_friend_request(uuid) from anon;
revoke execute on function public.respond_friend_request(uuid, boolean) from public;
revoke execute on function public.respond_friend_request(uuid, boolean) from anon;
revoke execute on function public.remove_friend(uuid) from public;
revoke execute on function public.remove_friend(uuid) from anon;
revoke execute on function public.block_member(uuid) from public;
revoke execute on function public.block_member(uuid) from anon;
revoke execute on function public.unblock_member(uuid) from public;
revoke execute on function public.unblock_member(uuid) from anon;

grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_member(uuid) to authenticated;
grant execute on function public.unblock_member(uuid) to authenticated;

grant execute on function public.friendship_pair_key(uuid, uuid) to anon;
grant execute on function public.friendship_pair_key(uuid, uuid) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop function if exists public.unblock_member(uuid);
-- drop function if exists public.block_member(uuid);
-- drop function if exists public.remove_friend(uuid);
-- drop function if exists public.respond_friend_request(uuid, boolean);
-- drop function if exists public.send_friend_request(uuid);
-- drop function if exists public.friendship_pair_key(uuid, uuid);
