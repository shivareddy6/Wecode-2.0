-- ============================================================================
-- Epic 04, Story 4 — remove a participant. The actual removal is a plain
-- `update room_participants set removed_at = now() ...` from the app layer
-- (apps/web/app/rooms/actions.ts's removeParticipant), the same
-- direct-table-update shape as endRound — no new SQL function needed,
-- since the existing "hosts can remove participants" RLS policy
-- (20260906130000_host_is_a_participant.sql) already restricts it to the
-- host and already excludes the host's own row.
--
-- The one thing that policy's soft-delete design didn't yet account for:
-- join_room() never had to consider a caller with removed_at already set,
-- since nothing ever set it before this story existed. Its "already a
-- member" check only matched active rows (removed_at is null), so a
-- removed participant clicking the same invite link would fall through
-- to the insert at the bottom and hit a duplicate-key error on the
-- (room_id, user_id) primary key — a raw DB error instead of a clear
-- message. Product decision, 2026-09-17: kicked means kicked — a removed
-- participant cannot rejoin the same room via the invite link. So this
-- adds an explicit check, ahead of the "already a member" one, that
-- rejects with a clear error instead of falling through to that insert.
-- ============================================================================

create or replace function public.join_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_cap integer;
  v_host uuid;
  v_count integer;
begin
  select status, participant_cap, host_user_id
  into v_status, v_cap, v_host
  from public.rooms
  where id = p_room_id
  for update;

  if v_host is null then
    raise exception 'Room not found.';
  end if;

  if exists (
    select 1 from public.room_participants
    where room_id = p_room_id and user_id = auth.uid() and removed_at is not null
  ) then
    raise exception 'You have been removed from this room.';
  end if;

  if exists (
    select 1 from public.room_participants
    where room_id = p_room_id and user_id = auth.uid() and removed_at is null
  ) then
    return;
  end if;

  if v_status <> 'open' then
    raise exception 'This room is closed and isn''t accepting new participants.';
  end if;

  select count(*) into v_count
  from public.room_participants
  where room_id = p_room_id and removed_at is null;

  if v_count >= v_cap then
    raise exception 'This room is full.';
  end if;

  insert into public.room_participants (room_id, user_id) values (p_room_id, auth.uid());
end;
$$;

revoke all on function public.join_room(uuid) from public;
grant execute on function public.join_room(uuid) to authenticated;

comment on function public.join_room(uuid) is
  'Locks the room row (FOR UPDATE) before checking or inserting anything, so concurrent joins near the cap serialize instead of racing. Rejects a caller with a removed_at row for this room outright (Epic 04, Story 4 product decision: kicked means kicked, no rejoin via the same link) before falling through to the ordinary "already a member"/insert path.';
