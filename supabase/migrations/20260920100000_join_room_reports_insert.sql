-- ============================================================================
-- Epic 04, Story 3 — live participant list. The list itself is pushed
-- over Epic 11's socket channel the same way Epic 06 Story 2 pushes the
-- leaderboard: whichever app-layer call just changed the roster
-- recomputes it and POSTs to /internal/broadcast right after, on the
-- same request.
--
-- The one thing that pattern needs from join_room() that it didn't
-- already give us: joinRoom() (apps/web/app/rooms/actions.ts) is called
-- on *every* room-page render, not just an actual first-time join — it's
-- a deliberate no-op for an existing member. Broadcasting a fresh
-- "participants:update" on every single page view (including the
-- 5-second refresh poll while a round is active) would spam every open
-- socket with an identical, unchanged roster. So join_room() now reports
-- back whether it actually inserted a new row, and the app only
-- broadcasts when that's true.
-- ============================================================================

drop function if exists public.join_room(uuid);

create function public.join_room(p_room_id uuid)
returns boolean
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
    return false;
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
  return true;
end;
$$;

revoke all on function public.join_room(uuid) from public;
grant execute on function public.join_room(uuid) to authenticated;

comment on function public.join_room(uuid) is
  'Locks the room row (FOR UPDATE) before checking or inserting anything, so concurrent joins near the cap serialize instead of racing. Rejects a caller with a removed_at row for this room outright (Epic 04, Story 4 product decision: kicked means kicked). Returns true only when it actually inserted a new row — false for the ordinary "already a member" no-op — so callers (joinRoom) know whether the roster actually changed and a participants:update broadcast (Epic 04, Story 3) is warranted.';
