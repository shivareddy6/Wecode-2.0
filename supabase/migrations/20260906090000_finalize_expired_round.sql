-- ============================================================================
-- finalize_expired_round — Epic 05, Story 5's lazy round-expiry flip.
-- There's no background job/cron in this app, so a round's timer expiring
-- isn't pushed by anything — it's detected whenever something reads or
-- acts on the room next (the room page render, a submission attempt) and
-- lazily written back here. The actual "reject a late submission" gate
-- (app/api/submissions/route.ts) checks the timestamps directly and
-- doesn't depend on this having run first; this only exists so
-- rooms.round_status converges to 'ended' for anyone just looking at the
-- room, instead of staying stuck on a stale 'active'.
--
-- SECURITY DEFINER (unlike start_room_round, which only the host can call
-- and which therefore works fine under the host-only "hosts manage their
-- own rooms" update policy): any room member should be able to trigger
-- this, not just the host — whoever happens to load the page or attempt a
-- late submission first — so it has to bypass that same host-only RLS
-- policy on purpose. search_path pinned and EXECUTE revoked from PUBLIC
-- then granted back to authenticated, per this schema's standing
-- convention (see docs/SCHEMA.md's Authorization model).
-- ============================================================================
create or replace function public.finalize_expired_round(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_room_member(p_room_id) or public.is_room_host(p_room_id)) then
    raise exception 'Not a member of this room.';
  end if;

  update public.rooms
  set round_status = 'ended'
  where id = p_room_id
    and round_status = 'active'
    and round_started_at is not null
    and now() >= round_started_at + (round_duration_seconds || ' seconds')::interval;
end;
$$;

revoke all on function public.finalize_expired_round(uuid) from public;
grant execute on function public.finalize_expired_round(uuid) to authenticated;
