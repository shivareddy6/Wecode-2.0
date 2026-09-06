-- array_agg() over zero rows returns NULL, not '{}' — missed on the
-- used_leetcode_slugs update itself (v_outgoing_slugs already had this
-- coalesced, this one didn't). Bites on the first round ever started in
-- a room, when both the existing slug list and the outgoing round are
-- still empty.
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
  v_outgoing_slugs text[];
  v_new_slugs text[];
begin
  if not public.is_room_host(p_room_id) then
    raise exception 'Only the room host can start a round.';
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
