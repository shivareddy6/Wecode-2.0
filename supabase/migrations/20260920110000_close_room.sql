-- ============================================================================
-- Epic 04, Story 5 — close a room. rooms.status ('open'/'closed') and
-- closed_at already existed from the original schema — join_room()
-- already rejected new joins on a non-open room from day one (Story 2).
-- The one gap: start_room_round() never checked room status at all, so a
-- closed room's host could still start a brand new round. This adds
-- that guard, ahead of the existing host-only check.
--
-- Deliberately not touched here, per the AC's own "closing is a hard
-- stop, not an archival step" line: existing access to the room's
-- current round/leaderboard/chat for people already in it. RLS's
-- is_room_member()/is_room_host() only ever check removed_at, never
-- rooms.status, so nothing about this migration changes who can still
-- read what in an already-closed room.
-- ============================================================================

create or replace function public.start_room_round(
  p_room_id uuid,
  p_problems jsonb,
  p_duration_seconds integer,
  p_preset text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_outgoing_slugs text[];
  v_new_slugs text[];
begin
  if not public.is_room_host(p_room_id) then
    raise exception 'Only the room host can start a round.';
  end if;

  select status into v_status from public.rooms where id = p_room_id;

  if v_status <> 'open' then
    raise exception 'This room is closed. No new rounds can be started.';
  end if;

  select coalesce(array_agg(elem ->> 'slug'), '{}')
  into v_outgoing_slugs
  from public.rooms, jsonb_array_elements(rooms.current_problems) elem
  where rooms.id = p_room_id;

  select coalesce(array_agg(elem ->> 'slug'), '{}')
  into v_new_slugs
  from jsonb_array_elements(p_problems) elem;

  if exists (
    select 1 from public.rooms
    where id = p_room_id
      and used_leetcode_slugs && v_new_slugs
  ) then
    raise exception 'One or more problems have already been used in this room.';
  end if;

  delete from public.submissions where room_id = p_room_id;

  update public.rooms
  set used_leetcode_slugs = (
        select coalesce(array_agg(distinct s), '{}')
        from unnest(used_leetcode_slugs || v_outgoing_slugs) s
      ),
      current_problems = p_problems,
      round_started_at = now(),
      round_duration_seconds = p_duration_seconds,
      round_preset = p_preset,
      round_status = 'active'
  where id = p_room_id;
end;
$$;
