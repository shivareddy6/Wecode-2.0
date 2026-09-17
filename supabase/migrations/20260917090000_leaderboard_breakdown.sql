-- ============================================================================
-- Epic 06, Story 4 — per-problem breakdown. compute_leaderboard() gives the
-- roster's total_score/problems_solved rollup; this adds the row-per-
-- (participant, current-round-problem) detail underneath it, scoped to
-- rooms.current_problems the same way compute_leaderboard() is scoped to
-- current submissions (see docs/SCHEMA.md's "Room-centric rounds" — a
-- round's problems live wholesale on rooms.current_problems, no
-- session_problems join needed).
--
-- Unlike compute_leaderboard(), this doesn't just exclude
-- is_out_of_contest submissions outright — Story 4's AC wants a late
-- accept still *visible*, clearly marked, contributing 0 points, not
-- hidden entirely. Hence the four-value `status`: an out-of-contest
-- accept is 'solved_out_of_contest', not folded into 'solved' or
-- silently dropped like it is in compute_leaderboard().
-- ============================================================================
create or replace function public.compute_leaderboard_breakdown(p_room_id uuid)
returns table (
  user_id uuid,
  problem_slug text,
  problem_title text,
  difficulty text,
  status text,
  problem_score numeric,
  attempt_count integer
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
  roster as (
    select rp.user_id
    from public.room_participants rp
    where rp.room_id = p_room_id and rp.removed_at is null
  ),
  -- First accepted submission per (user, problem), in-contest or not —
  -- unlike compute_leaderboard()'s first_accepts, this deliberately does
  -- NOT filter out is_out_of_contest, since Story 4 wants that row
  -- visible (as 'solved_out_of_contest'), not absent.
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
    coalesce(ac.total_attempts, 0)::int as attempt_count
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

revoke all on function public.compute_leaderboard_breakdown(uuid) from public;
grant execute on function public.compute_leaderboard_breakdown(uuid) to authenticated;

comment on function public.compute_leaderboard_breakdown(uuid) is
  'Row-per-(participant, current-round-problem) detail underneath compute_leaderboard()''s rollup. Attempted-but-never-solved and never-attempted both score 0 with no penalty (ACM convention, same as compute_leaderboard()). An out-of-contest accept is reported as status = solved_out_of_contest with problem_score = 0 — visible, not hidden or folded into solved, per Epic 06 Story 4''s product decision. SECURITY INVOKER — relies on the caller''s own RLS-granted select access to submissions/room_participants.';
