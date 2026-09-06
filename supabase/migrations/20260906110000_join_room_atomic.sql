-- ============================================================================
-- join_room — replaces the app-layer "read active roster, then insert"
-- pattern in app/rooms/actions.ts's joinRoom, which had a real race
-- condition: two concurrent joins could both read a count under the cap
-- and both insert, overfilling a room past participant_cap. `SELECT ...
-- FOR UPDATE` on the room row here serializes every join attempt against
-- that specific room — a second caller's lock acquisition blocks until
-- the first's transaction commits (insert + all), so the count it then
-- reads is never stale. Same "one atomic function instead of separate
-- app-layer round trips" shape as start_room_round()/finalize_expired_round().
--
-- SECURITY DEFINER, like finalize_expired_round: a prospective joiner
-- isn't a member yet, so they have no RLS-granted read access to `rooms`
-- to even acquire the lock, let alone read participant_cap/status.
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

  if v_host = auth.uid() then
    return;
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
