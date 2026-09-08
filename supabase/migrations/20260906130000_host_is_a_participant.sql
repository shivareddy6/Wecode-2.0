-- ============================================================================
-- Epic 04/06 — design switch, decided after review: the host now gets a
-- real room_participants row too, instead of being tracked purely via
-- rooms.host_user_id with every roster query (compute_leaderboard, the
-- future participant list, chat presence, ...) having to UNION it back
-- in. rooms.host_user_id still exists and still means "who currently
-- holds host powers" — it's just no longer the *only* place the host is
-- recorded. This was chosen specifically because host transfer is coming:
-- under this design, transferring host is a single UPDATE on
-- rooms.host_user_id, and the outgoing host keeps their participant row
-- (and leaderboard standing, and chat presence) automatically, with
-- nothing to re-create. It also means the host now correctly counts
-- against participant_cap, per product decision — the cap bounds total
-- humans in the room, not "non-host humans."
--
-- Three changes:
--   1. Backfill: every existing room's host gets a room_participants row
--      if it doesn't already have one.
--   2. New create_room() — atomic room + host-participant-row creation,
--      the "create room" analogue of join_room()/start_room_round()'s
--      "one SQL function, not separate app-layer round trips" pattern.
--   3. join_room() loses its host-specific early return — the generic
--      "already a member" check now covers the host case identically,
--      since the host already has a row from create_room() (or the
--      backfill above).
--   4. compute_leaderboard() loses the UNION with host_user_id added in
--      20260906120000 — room_participants alone is the complete roster
--      again, which was the whole point.
--   5. A guard on "hosts can remove participants" so a future remove-
--      participant action (Epic 04, Story 4 — not built yet) can never
--      target the host's own row, closing the gap that giving the host a
--      real, updatable row would otherwise open. Design A never needed
--      this (the host had no row to remove); Design B does, and this is
--      that one guard, added while touching this policy anyway.
-- ============================================================================

-- 1. Backfill.
insert into public.room_participants (room_id, user_id)
select r.id, r.host_user_id
from public.rooms r
where not exists (
  select 1 from public.room_participants rp
  where rp.room_id = r.id and rp.user_id = r.host_user_id
);

-- 2. create_room() — SECURITY INVOKER: both inserts are already something
-- the calling user is allowed to do individually under existing RLS
-- ("authenticated users can create rooms" with check host_user_id =
-- auth.uid(); "users can join a room for themselves" with check user_id =
-- auth.uid()) — this function exists for atomicity, not to bypass
-- anything. set search_path = public per this schema's SECURITY DEFINER
-- convention; harmless but consistent even though INVOKER doesn't strictly
-- require it.
create or replace function public.create_room(p_invite_code text)
returns public.rooms
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  insert into public.rooms (host_user_id, invite_code)
  values (auth.uid(), p_invite_code)
  returning * into v_room;

  insert into public.room_participants (room_id, user_id)
  values (v_room.id, auth.uid());

  return v_room;
end;
$$;

revoke all on function public.create_room(text) from public;
grant execute on function public.create_room(text) to authenticated;

comment on function public.create_room(text) is
  'Atomic room creation: inserts the room and the creator''s own room_participants row (host is a real participant from the start, Epic 04/06 design decision) in one transaction. SECURITY INVOKER — relies on the caller''s own RLS-granted insert access to both tables.';

-- 3. join_room() — drop the host-specific early return; the "already a
-- member" check below it now catches the host case too, since every host
-- has a room_participants row from create_room()/the backfill above.
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
  'Locks the room row (FOR UPDATE) before checking or inserting anything, so concurrent joins near the cap serialize instead of racing. No host special-case: the host already has a room_participants row (create_room()/backfill), so the "already a member" check above no-ops for them the same as for anyone else.';

-- 4. compute_leaderboard() — back to a plain room_participants read, now
-- that it's the complete roster including the host.
create or replace function public.compute_leaderboard(p_room_id uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  total_score numeric,
  problems_solved integer,
  last_accepted_at timestamptz
)
language sql
security invoker
stable
set search_path = public
as $$
  with cfg as (
    select
      max(value) filter (where key = 'base_points_easy') as base_easy,
      max(value) filter (where key = 'base_points_medium') as base_medium,
      max(value) filter (where key = 'base_points_hard') as base_hard,
      max(value) filter (where key = 'decay_floor_pct') as floor_pct,
      max(value) filter (where key = 'wrong_submission_penalty') as penalty
    from public.scoring_config
  ),
  room as (
    select id, round_started_at, round_duration_seconds
    from public.rooms
    where id = p_room_id
  ),
  first_accepts as (
    select distinct on (sub.user_id, sub.problem_slug)
      sub.user_id,
      sub.problem_slug,
      sub.difficulty,
      sub.judged_at,
      (
        select count(*) from public.submissions earlier
        where earlier.room_id = p_room_id
          and earlier.problem_slug = sub.problem_slug
          and earlier.user_id = sub.user_id
          and earlier.verdict <> 'accepted'
          and not earlier.is_out_of_contest
          and earlier.submitted_at < sub.submitted_at
      ) as wrong_before
    from public.submissions sub
    where sub.room_id = p_room_id
      and sub.verdict = 'accepted'
      and not sub.is_out_of_contest
    order by sub.user_id, sub.problem_slug, sub.judged_at asc
  ),
  scored as (
    select
      fa.user_id,
      fa.problem_slug,
      fa.judged_at,
      greatest(
        0,
        (case fa.difficulty
           when 'easy' then cfg.base_easy
           when 'medium' then cfg.base_medium
           when 'hard' then cfg.base_hard
         end)
        * greatest(
            cfg.floor_pct,
            1 - (1 - cfg.floor_pct) * (
              extract(epoch from (fa.judged_at - room.round_started_at)) / room.round_duration_seconds
            )
          )
        - (fa.wrong_before * cfg.penalty)
      ) as problem_score
    from first_accepts fa
    cross join cfg
    cross join room
  )
  select
    u.id as user_id,
    u.display_name,
    u.avatar_url,
    coalesce(sum(scored.problem_score), 0) as total_score,
    count(scored.problem_slug)::int as problems_solved,
    max(scored.judged_at) as last_accepted_at
  from public.users u
  left join scored on scored.user_id = u.id
  where u.id in (
    select rp.user_id from public.room_participants rp
    where rp.room_id = p_room_id and rp.removed_at is null
  )
  group by u.id, u.display_name, u.avatar_url
  order by total_score desc, last_accepted_at asc nulls last;
$$;

comment on function public.compute_leaderboard(uuid) is
  'Room-scoped, not session-scoped — submissions are cleared at every round transition (start_room_round), so all of a room''s current submissions ARE the current round''s submissions. Excludes is_out_of_contest submissions entirely (no score, no penalty contribution). The host is included via the ordinary room_participants roster, same as anyone else (Epic 04/06 design decision: the host has a real participant row, not a separate union) — see create_room(). SECURITY INVOKER — relies on the caller already having read access via their own RLS grants.';

-- 5. Guard: a host-only "remove participant" action can never target the
-- host's own row. Nothing calls this update path yet (Epic 04, Story 4
-- isn't built), but the invariant belongs at the DB layer, not hoped-for
-- in application code that doesn't exist yet.
drop policy if exists "hosts can remove participants" on public.room_participants;

create policy "hosts can remove participants"
  on public.room_participants for update
  to authenticated
  using (
    public.is_room_host(room_id)
    and user_id <> (select host_user_id from public.rooms where id = room_id)
  );
