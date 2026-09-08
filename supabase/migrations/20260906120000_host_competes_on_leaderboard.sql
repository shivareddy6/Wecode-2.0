-- ============================================================================
-- Epic 06, Story 1 — product decision (see docs/epics/06-leaderboard-scoring.md
-- Story 1's "known gap"): the host is no different from any other user
-- except for the start/end/restart-round powers — they compete on the
-- leaderboard by default, without needing to also hold a room_participants
-- row. compute_leaderboard()'s final filter previously only recognized
-- room_participants rows, so a host's own accepted submissions could never
-- appear no matter what they solved. Fixed by unioning rooms.host_user_id
-- into the same "who counts" set (UNION dedupes, so a host who *also*
-- explicitly joined isn't counted twice).
--
-- CREATE OR REPLACE does NOT preserve an ALTER-set search_path (bit us
-- once already — see pin_compute_leaderboard_search_path), so
-- `set search_path = public` stays inline in this definition rather than
-- a separate ALTER FUNCTION afterward.
-- ============================================================================
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
    union
    select r.host_user_id from public.rooms r where r.id = p_room_id
  )
  group by u.id, u.display_name, u.avatar_url
  order by total_score desc, last_accepted_at asc nulls last;
$$;

comment on function public.compute_leaderboard(uuid) is
  'Room-scoped, not session-scoped — submissions are cleared at every round transition (start_room_round), so all of a room''s current submissions ARE the current round''s submissions. Excludes is_out_of_contest submissions entirely (no score, no penalty contribution). The host always competes (unioned in via rooms.host_user_id) whether or not they also hold a room_participants row — product decision, Epic 06 Story 1. SECURITY INVOKER — relies on the caller already having read access via their own RLS grants.';
