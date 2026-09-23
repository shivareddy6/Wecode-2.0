-- ============================================================================
-- Reconciles a real inconsistency flagged across several handoffs:
-- docs/SCHEMA.md documents removal as soft specifically "so chat and
-- leaderboard history stay attributable to a real person even after a
-- host kicks them" (Epic 04, Story 4) — but compute_leaderboard() and
-- compute_leaderboard_breakdown() both filtered their roster to
-- room_participants.removed_at is null, so a kicked user's entire score
-- and per-problem history vanished from both leaderboard views the moment
-- they were removed, even though chat (including their submission-activity
-- entries, Epic 07 Story 5) kept showing them. This was the leaderboard
-- failing to honor a contract the schema already committed to, not a new
-- feature.
--
-- Fix: both functions now include every participant regardless of
-- removed_at, with a new is_removed column so a kicked user's history is
-- visible but clearly marked — the same "visible, not hidden" precedent
-- compute_leaderboard_breakdown() already set for is_out_of_contest.
-- ============================================================================

-- Both functions are gaining a new output column (is_removed), which is a
-- return-type change — a bare CREATE OR REPLACE errors on that, so both
-- need an explicit DROP first (this also wipes their grants/comments,
-- reapplied below — same gotcha re-hit in the join_room_reports_insert
-- migration).
drop function if exists public.compute_leaderboard(uuid);
drop function if exists public.compute_leaderboard_breakdown(uuid);

create or replace function public.compute_leaderboard(p_room_id uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  total_score numeric,
  problems_solved integer,
  last_accepted_at timestamptz,
  is_removed boolean
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
    max(scored.judged_at) as last_accepted_at,
    (rp.removed_at is not null) as is_removed
  from public.room_participants rp
  join public.users u on u.id = rp.user_id
  left join scored on scored.user_id = u.id
  where rp.room_id = p_room_id
  group by u.id, u.display_name, u.avatar_url, rp.removed_at
  order by total_score desc, last_accepted_at asc nulls last;
$$;

comment on function public.compute_leaderboard(uuid) is
  'Room-scoped, not session-scoped — submissions are cleared at every round transition (start_room_round), so all of a room''s current submissions ARE the current round''s submissions. Excludes is_out_of_contest submissions entirely (no score, no penalty contribution). Includes every participant who has ever been in the room, not just currently-active ones (leaderboard_includes_removed migration) — a kicked participant''s history stays visible, flagged via is_removed, matching docs/SCHEMA.md''s "chat and leaderboard history stay attributable" rationale for soft-deleting removals. SECURITY INVOKER — relies on the caller already having read access via their own RLS grants.';

create or replace function public.compute_leaderboard_breakdown(p_room_id uuid)
returns table (
  user_id uuid,
  problem_slug text,
  problem_title text,
  difficulty text,
  status text,
  problem_score numeric,
  attempt_count integer,
  is_removed boolean
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
  problems as (
    select
      elem ->> 'slug' as problem_slug,
      elem ->> 'title' as problem_title,
      elem ->> 'difficulty' as difficulty
    from public.rooms, jsonb_array_elements(rooms.current_problems) elem
    where rooms.id = p_room_id
  ),
  -- Every participant this room has ever had, not just currently-active
  -- ones — see the migration header. is_removed carries through to the
  -- final select so a kicked participant's breakdown rows are visible but
  -- flagged, same "visible, not hidden" precedent as solved_out_of_contest.
  roster as (
    select rp.user_id, (rp.removed_at is not null) as is_removed
    from public.room_participants rp
    where rp.room_id = p_room_id
  ),
  first_accepts as (
    select distinct on (sub.user_id, sub.problem_slug)
      sub.user_id,
      sub.problem_slug,
      sub.judged_at,
      sub.is_out_of_contest,
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
    order by sub.user_id, sub.problem_slug, sub.judged_at asc
  ),
  attempt_counts as (
    select user_id, problem_slug, count(*) as total_attempts
    from public.submissions
    where room_id = p_room_id
    group by user_id, problem_slug
  )
  select
    roster.user_id,
    problems.problem_slug,
    problems.problem_title,
    problems.difficulty,
    case
      when fa.user_id is null then 'not_attempted'
      when fa.is_out_of_contest then 'solved_out_of_contest'
      else 'solved'
    end as status,
    case
      when fa.user_id is null or fa.is_out_of_contest then 0
      else greatest(
        0,
        (case problems.difficulty
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
      )
    end as problem_score,
    coalesce(ac.total_attempts, 0)::int as attempt_count,
    roster.is_removed
  from roster
  cross join problems
  cross join cfg
  cross join room
  left join first_accepts fa
    on fa.user_id = roster.user_id and fa.problem_slug = problems.problem_slug
  left join attempt_counts ac
    on ac.user_id = roster.user_id and ac.problem_slug = problems.problem_slug
  order by roster.user_id, problems.problem_slug;
$$;

comment on function public.compute_leaderboard_breakdown(uuid) is
  'Row-per-(participant, current-round-problem) detail underneath compute_leaderboard()''s rollup. Attempted-but-never-solved and never-attempted both score 0 with no penalty (ACM convention, same as compute_leaderboard()). An out-of-contest accept is reported as status = solved_out_of_contest with problem_score = 0 — visible, not hidden or folded into solved, per Epic 06 Story 4''s product decision. Includes every participant who has ever been in the room, not just currently-active ones (leaderboard_includes_removed migration), flagged via is_removed. SECURITY INVOKER — relies on the caller''s own RLS-granted select access to submissions/room_participants.';

-- The DROP above also wiped compute_leaderboard_breakdown()'s grants
-- (compute_leaderboard() was never explicitly granted/revoked — it relies
-- on the default PUBLIC execute grant a fresh CREATE FUNCTION gets, so it
-- needs no re-grant here).
revoke all on function public.compute_leaderboard_breakdown(uuid) from public;
grant execute on function public.compute_leaderboard_breakdown(uuid) to authenticated;
