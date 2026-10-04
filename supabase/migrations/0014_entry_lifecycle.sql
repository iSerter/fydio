-- =============================================================================
-- T04 · 0014 — Entry lifecycle (hashtag swap, edit, hide/unhide, remove) + covers
-- =============================================================================
--
-- `create_content_entry` (0005) spends the Credit and publishes the row, but a
-- published entry is not immutable: the author retags it, edits the note, hides
-- it, or removes it. These five functions are that lifecycle.
--
-- WHY EVERY FUNCTION IS SECURITY DEFINER AND RE-CHECKS AUTHORSHIP
-- 0009 already allows an author to UPDATE their own entry row and write their own
-- `content_hashtags` rows. Going through SECURITY DEFINER bypasses RLS, so the
-- same rule has to be re-asserted here: author OR admin, checked against
-- `auth.uid()` inside the function. Without it any authenticated member could
-- retag or hide anyone else's entry by calling the function directly.
--
-- WHY NO FUNCTION HERE TOUCHES THE LEDGER
-- Hiding and removing are visibility changes, not refunds. There is deliberately
-- no refund path: the submission spend stays spent even when the entry is
-- removed, so a member cannot submit, earn attention, remove, and resubmit the
-- same URL for free. `remove_entry` states this explicitly at its call site.
--
-- WHY `set_entry_hashtags` DELETES THEN INSERTS
-- The exactly-three rule is a DEFERRABLE INITIALLY DEFERRED constraint trigger
-- (0005), so it only observes settled rows at COMMIT. Deleting all three and
-- inserting the new three in one transaction is invisible to it -- which is
-- exactly why "swap the tag set" works while "leave two" does not.

-- --- set_entry_hashtags(): the three-tag swap, no credit movement --------------

create or replace function public.set_entry_hashtags(p_entry_id uuid, p_hashtags uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_entry    public.content_entries;
  v_total    integer := coalesce(array_length(p_hashtags, 1), 0);
  v_distinct integer;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Row lock so two concurrent swaps serialise instead of interleaving a delete
  -- from one with the insert of the other.
  select * into v_entry
    from public.content_entries
   where id = p_entry_id
     for update;

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id <> v_uid and not public.is_admin() then
    raise exception 'That entry is not yours to edit' using errcode = 'insufficient_privilege';
  end if;

  -- Removal is terminal: a removed row keeps its audit trail but accepts no
  -- further edits. Without this a removed entry could be retagged back into
  -- relevance through its hashtag rows.
  if v_entry.status = 'removed' then
    raise exception 'Entry is removed' using errcode = 'check_violation';
  end if;

  -- Exactly three DISTINCT tags. Distinct as well as counted: the same tag
  -- listed twice is not two tags, and `array_length` alone would still say 3.
  select count(distinct h) into v_distinct from unnest(p_hashtags) h;

  if v_total <> 3 or v_distinct <> 3 then
    raise exception 'Exactly three distinct hashtags are required'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from unnest(p_hashtags) h
     where not exists (select 1 from public.hashtags where id = h)
  ) then
    raise exception 'Unknown hashtag' using errcode = 'foreign_key_violation';
  end if;

  -- No credit movement here: retagging is free.

  delete from public.content_hashtags where content_entry_id = p_entry_id;

  insert into public.content_hashtags (content_entry_id, hashtag_id, position)
  select p_entry_id, t.h, t.ord - 1
    from unnest(p_hashtags) with ordinality as t(h, ord);
end;
$$;

-- --- update_entry(): note + feedback flag --------------------------------------
--
-- `p_creator_note` is nullable with a deliberate empty-string-means-null
-- convention: passing '' clears the note, passing null leaves it untouched.
-- A separate boolean flag parameter would be a wider signature for a case the
-- UI expresses as "clear the field".

create or replace function public.update_entry(
  p_entry_id uuid,
  p_creator_note text default null,
  p_asks_for_feedback boolean default null
)
returns public.content_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_entry
    from public.content_entries
   where id = p_entry_id
     for update;

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id <> v_uid and not public.is_admin() then
    raise exception 'That entry is not yours to edit' using errcode = 'insufficient_privilege';
  end if;

  -- Removal is terminal: matches set_entry_hashtags/hide_entry.
  if v_entry.status = 'removed' then
    raise exception 'Entry is removed' using errcode = 'check_violation';
  end if;

  -- Length is refused rather than silently truncated: truncation would store text
  -- the author did not write, and the column CHECK would only catch it at write
  -- time with a less actionable message.
  if p_creator_note is not null and char_length(p_creator_note) > 1000 then
    raise exception 'Creator note must be 1000 characters or fewer'
      using errcode = 'check_violation';
  end if;

  update public.content_entries
     set creator_note = case
                          when p_creator_note is not null then nullif(p_creator_note, '')
                          else creator_note
                        end,
         asks_for_feedback = coalesce(p_asks_for_feedback, asks_for_feedback)
   where id = p_entry_id
  returning * into v_entry;

  return v_entry;
end;
$$;

-- --- hide_entry() / unhide_entry(): visibility without ledger movement --------
--
-- Hiding is reversible by the author (unhide); removing is terminal. Both are
-- idempotent in the direction they move: hiding an already-hidden entry returns
-- it unchanged rather than erroring, so a retried request is safe.

create or replace function public.hide_entry(p_entry_id uuid)
returns public.content_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_entry
    from public.content_entries
   where id = p_entry_id
     for update;

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id <> v_uid and not public.is_admin() then
    raise exception 'That entry is not yours to hide' using errcode = 'insufficient_privilege';
  end if;

  if v_entry.status = 'removed' then
    raise exception 'Entry is removed' using errcode = 'check_violation';
  end if;

  if v_entry.status = 'hidden' then
    return v_entry;
  end if;

  -- No ledger change: hiding is a visibility flag, not a refund.
  update public.content_entries
     set status = 'hidden'
   where id = p_entry_id
     and status = 'active'
  returning * into v_entry;

  return v_entry;
end;
$$;

create or replace function public.unhide_entry(p_entry_id uuid)
returns public.content_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_entry
    from public.content_entries
   where id = p_entry_id
     for update;

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id <> v_uid and not public.is_admin() then
    raise exception 'That entry is not yours to unhide' using errcode = 'insufficient_privilege';
  end if;

  if v_entry.status = 'removed' then
    raise exception 'Entry is removed' using errcode = 'check_violation';
  end if;

  if v_entry.status = 'active' then
    return v_entry;
  end if;

  -- No ledger change: unhiding restores visibility, it does not re-spend.
  update public.content_entries
     set status = 'active'
   where id = p_entry_id
     and status = 'hidden'
  returning * into v_entry;

  return v_entry;
end;
$$;

-- --- remove_entry(): terminal, audit row retained ------------------------------
--
-- The row is kept (status + deleted_at) so the audit trail and any credit
-- reversal stay resolvable. The spend is NOT refunded: there is no refund path
-- by design, so remove-then-resubmit cannot mint free submissions.

create or replace function public.remove_entry(p_entry_id uuid)
returns public.content_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_entry public.content_entries;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_entry
    from public.content_entries
   where id = p_entry_id
     for update;

  if not found then
    raise exception 'Entry not found' using errcode = 'no_data_found';
  end if;

  if v_entry.author_id <> v_uid and not public.is_admin() then
    raise exception 'That entry is not yours to remove' using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent like hide/unhide: a retried remove returns the row unchanged
  -- rather than re-stamping deleted_at, so retries are safe.
  if v_entry.status = 'removed' then
    return v_entry;
  end if;

  -- No ledger change (explicit): no refund path. The submission spend stays spent.
  update public.content_entries
     set status = 'removed',
         deleted_at = now()
   where id = p_entry_id
  returning * into v_entry;

  return v_entry;
end;
$$;

-- =============================================================================
-- Covers storage
-- =============================================================================
--
-- Entry cover images. Same shape as the avatars bucket in 0012: public read
-- (covers render in other members' feeds), owner-folder write (the first path
-- segment is the author id, so `foldername(name)[1] = auth.uid()::text` is an
-- ownership test). 5 MB is the pre-re-encode ceiling and a backstop against a
-- direct Storage-API upload that bypassed the route.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'covers',
  'covers',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "covers are publicly readable" on storage.objects;

create policy "covers are publicly readable"
  on storage.objects
  for select
  using (bucket_id = 'covers');

drop policy if exists "members upload to own cover folder" on storage.objects;

create policy "members upload to own cover folder"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members update own cover" on storage.objects;

create policy "members update own cover"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "members delete own cover" on storage.objects;

create policy "members delete own cover"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);

-- =============================================================================
-- EXECUTE grants
-- =============================================================================
--
-- Same discipline as 0012/0013 and for the same documented reason (see 0009):
-- this image's `alter default privileges` hands every new function to `anon`
-- and `authenticated` at CREATE time, so a missing revoke is not "not granted",
-- it is "granted to everyone".

revoke execute on function public.set_entry_hashtags(uuid, uuid[]) from public;
revoke execute on function public.set_entry_hashtags(uuid, uuid[]) from anon;
revoke execute on function public.update_entry(uuid, text, boolean) from public;
revoke execute on function public.update_entry(uuid, text, boolean) from anon;
revoke execute on function public.hide_entry(uuid) from public;
revoke execute on function public.hide_entry(uuid) from anon;
revoke execute on function public.unhide_entry(uuid) from public;
revoke execute on function public.unhide_entry(uuid) from anon;
revoke execute on function public.remove_entry(uuid) from public;
revoke execute on function public.remove_entry(uuid) from anon;

grant execute on function public.set_entry_hashtags(uuid, uuid[]) to authenticated;
grant execute on function public.update_entry(uuid, text, boolean) to authenticated;
grant execute on function public.hide_entry(uuid) to authenticated;
grant execute on function public.unhide_entry(uuid) to authenticated;
grant execute on function public.remove_entry(uuid) to authenticated;

-- =============================================================================
-- DOWN
-- =============================================================================
-- drop policy if exists "members delete own cover" on storage.objects;
-- drop policy if exists "members update own cover" on storage.objects;
-- drop policy if exists "members upload to own cover folder" on storage.objects;
-- drop policy if exists "covers are publicly readable" on storage.objects;
-- delete from storage.buckets where id = 'covers';
-- drop function if exists public.remove_entry(uuid);
-- drop function if exists public.unhide_entry(uuid);
-- drop function if exists public.hide_entry(uuid);
-- drop function if exists public.update_entry(uuid, text, boolean);
-- drop function if exists public.set_entry_hashtags(uuid, uuid[]);
