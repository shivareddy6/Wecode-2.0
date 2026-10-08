-- ============================================================================
-- Replaces the leaderboard's scoring formula shape (not just its tunable
-- values) to match real LeetCode contest scoring, per product decision
-- 2026-09-26: each problem is worth a FIXED base_points_<difficulty> once
-- accepted in-contest — no more continuous time-decay of the point value.
-- Wrong in-contest attempts before the accept no longer subtract points;
-- they add wrong_submission_penalty_minutes (new: 5, replacing the old
-- 10-point subtraction) to that problem's time-to-solve instead. Ranking is
-- now: total_score desc, then total_time_minutes asc as the only tiebreak —
-- LeetCode's own "score first, elapsed+penalized time breaks ties" model.
-- decay_floor_pct is retired entirely; there is nothing left for it to do
-- once scoring has no decay curve.
--
-- Deliberately NOT weighting time by which problem it was spent on (e.g.
-- rewarding "solved the hard one fast, easy one slow" over the reverse) —
-- real LeetCode doesn't do that either; two users who solve the same set of
-- problems in opposite order and the same total time tie exactly, and that
-- is correct behavior here too, not a bug.
--
-- Both functions are gaining/losing output columns, which is a return-type
-- change — a bare CREATE OR REPLACE errors on that, so both need an
-- explicit DROP first (same gotcha as the leaderboard_includes_removed
-- migration).
-- ============================================================================

delete from public.scoring_config where key in ('decay_floor_pct', 'wrong_submission_penalty');

insert into public.scoring_config (key, value) values
  ('wrong_submission_penalty_minutes', 5);

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
  total_time_minutes numeric,
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
      max(value) filter (where key = 'wrong_submission_penalty_minutes') as penalty_minutes
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
      case fa.difficulty
        when 'easy' then cfg.base_easy
        when 'medium' then cfg.base_medium
        when 'hard' then cfg.base_hard
      end as problem_score,
      extract(epoch from (fa.judged_at - room.round_started_at)) / 60.0
        + fa.wrong_before * cfg.penalty_minutes as problem_time_minutes
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
    coalesce(sum(scored.problem_time_minutes), 0) as total_time_minutes,
    (rp.removed_at is not null) as is_removed
  from public.room_participants rp
  join public.users u on u.id = rp.user_id
  left join scored on scored.user_id = u.id
  where rp.room_id = p_room_id
  group by u.id, u.display_name, u.avatar_url, rp.removed_at
  order by total_score desc, total_time_minutes asc;
$$;

comment on function public.compute_leaderboard(uuid) is
  'LeetCode-style contest scoring (leetcode_style_scoring migration): each problem is worth a fixed base_points_<difficulty> once accepted in-contest — no time decay of the point value. Wrong in-contest attempts before the accept no longer subtract points; they add wrong_submission_penalty_minutes each to that problem''s time-to-solve instead. total_time_minutes sums (minutes from round start to accept) + penalty minutes across every solved problem, and is the secondary sort key (ascending) after total_score (descending) — real LeetCode contest ranking, score first, total elapsed+penalized time as the only tiebreak. No weighting of time by which problem it was spent on: solving the same set of problems in a different order that sums to the same total time ties exactly, by design. Room-scoped, not session-scoped. Excludes is_out_of_contest submissions entirely (no score, no time contribution). Includes every participant who has ever been in the room, not just currently-active ones, flagged via is_removed. SECURITY INVOKER — relies on the caller already having read access via their own RLS grants.';

create or replace function public.compute_leaderboard_breakdown(p_room_id uuid)
returns table (
  user_id uuid,
  problem_slug text,
  problem_title text,
  difficulty text,
  status text,
  problem_score numeric,
  problem_time_minutes numeric,
  wrong_before integer,
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
      max(value) filter (where key = 'wrong_submission_penalty_minutes') as penalty_minutes
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
  -- ones — see leaderboard_includes_removed. is_removed carries through to
  -- the final select so a kicked participant's breakdown rows are visible
  -- but flagged, same "visible, not hidden" precedent as solved_out_of_contest.
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
      else case problems.difficulty
             when 'easy' then cfg.base_easy
             when 'medium' then cfg.base_medium
             when 'hard' then cfg.base_hard
           end
    end as problem_score,
    -- null (not 0) for not_attempted/solved_out_of_contest — only a real
    -- in-contest solve has a meaningful time-to-solve or penalty to show.
    case
      when fa.user_id is null or fa.is_out_of_contest then null
      else extract(epoch from (fa.judged_at - room.round_started_at)) / 60.0
             + fa.wrong_before * cfg.penalty_minutes
    end as problem_time_minutes,
    case
      when fa.user_id is null or fa.is_out_of_contest then null
      else fa.wrong_before
    end as wrong_before,
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
  'Row-per-(participant, current-round-problem) detail underneath compute_leaderboard()''s rollup, same fixed-points-plus-time-penalty model (leetcode_style_scoring migration). problem_time_minutes/wrong_before are null for not_attempted/solved_out_of_contest rows — only a real in-contest solve has a meaningful time-to-solve or penalty. An out-of-contest accept is reported as status = solved_out_of_contest with problem_score = 0, per Epic 06 Story 4''s product decision. Includes every participant who has ever been in the room, not just currently-active ones, flagged via is_removed. SECURITY INVOKER — relies on the caller''s own RLS-granted select access to submissions/room_participants.';

-- The DROP above also wiped compute_leaderboard_breakdown()'s grants
-- (compute_leaderboard() was never explicitly granted/revoked — it relies
-- on the default PUBLIC execute grant a fresh CREATE FUNCTION gets, so it
-- needs no re-grant here).
revoke all on function public.compute_leaderboard_breakdown(uuid) from public;
grant execute on function public.compute_leaderboard_breakdown(uuid) to authenticated;
