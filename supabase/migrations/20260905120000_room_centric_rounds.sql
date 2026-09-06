-- ============================================================================
-- Room-centric rounds — replaces sessions/session_problems as a growing
-- history table with current-round state directly on rooms, plus a
-- permanent anti-repeat slug list. See docs/SCHEMA.md for the rationale:
-- the only cross-round requirement is "never repeat a problem in this
-- room," which is a text[] on rooms, not a relational history nobody ever
-- reads (no history UI, no cross-round leaderboard — those were the two
-- things that would have justified keeping the old shape).
-- ============================================================================

drop function if exists public.compute_leaderboard(uuid);

drop table if exists public.submissions cascade;
drop table if exists public.session_problems cascade;
drop table if exists public.sessions cascade;

alter table public.rooms
  add column current_problems jsonb not null default '[]'::jsonb,
  add column round_started_at timestamptz,
  add column round_duration_seconds integer,
  add column round_preset text check (round_preset in ('warm_up', 'balanced', 'challenge', 'gauntlet')),
  add column round_status text check (round_status in ('active', 'ended')),
  add column used_leetcode_slugs text[] not null default '{}';

comment on column public.rooms.current_problems is
  'Ordered array of {slug, title, difficulty} for the room''s current round. Wholesale-replaced by start_room_round() every round — never partially updated, so a submission must denormalize whatever it needs (see submissions.difficulty) rather than joining back to this later.';
comment on column public.rooms.used_leetcode_slugs is
  'Every problem slug this room has ever run, across all rounds — permanent anti-repeat memory. Along with chat_messages, the only thing that survives a round transition.';

-- ============================================================================
-- submissions — room + slug directly, no session_problems hop. difficulty
-- is denormalized at insert time (from rooms.current_problems, looked up
-- server-side, never client-supplied) because current_problems is mutable
-- and a submission must not lose the ability to score itself correctly
-- after the room moves to its next round.
-- ============================================================================
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  problem_slug text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  user_id uuid not null references public.users (id) on delete cascade,
  language text not null check (language in ('python3', 'java', 'cpp', 'javascript', 'go', 'c')),
  leetcode_submission_id text,
  verdict text not null default 'pending'
    check (verdict in ('pending', 'accepted', 'wrong_answer', 'runtime_error', 'time_limit_exceeded', 'compile_error', 'other')),
  submitted_at timestamptz not null default now(),
  judged_at timestamptz
);

create index submissions_room_problem_user_idx
  on public.submissions (room_id, problem_slug, user_id, submitted_at);

alter table public.submissions enable row level security;

create policy "room members and host can view submissions in their room"
  on public.submissions for select
  to authenticated
  using (public.is_room_member(room_id) or public.is_room_host(room_id));

create policy "users can only submit as themselves"
  on public.submissions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and (public.is_room_member(room_id) or public.is_room_host(room_id))
  );

create policy "users can update their own submissions"
  on public.submissions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "start_room_round can clear submissions for a new round"
  on public.submissions for delete
  to authenticated
  using (public.is_room_host(room_id));

-- ============================================================================
-- start_room_round — the one atomic round-transition point: snapshot the
-- outgoing round's slugs into permanent anti-repeat memory, clear its
-- submissions (abandoning anything still mid-judging is an accepted
-- tradeoff — the product explicitly doesn't care once the room has moved
-- on), and install the new round's state. One function so all of this
-- commits or fails together, instead of several separate app-layer round
-- trips that could leave rooms in an inconsistent state if one failed.
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
        select array_agg(distinct s)
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

revoke all on function public.start_room_round(uuid, jsonb, integer, text) from public;
grant execute on function public.start_room_round(uuid, jsonb, integer, text) to authenticated;

-- ============================================================================
-- compute_leaderboard — now room-scoped, not session-scoped. This is safe
-- by construction, not by convention: start_room_round() deletes a room's
-- submissions on every round transition, so "all of a room's current
-- submissions" IS "this round's submissions" — no separate scoping needed.
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
          and earlier.submitted_at < sub.submitted_at
      ) as wrong_before
    from public.submissions sub
    where sub.room_id = p_room_id
      and sub.verdict = 'accepted'
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
  'Room-scoped, not session-scoped — submissions are cleared at every round transition (start_room_round), so all of a room''s current submissions ARE the current round''s submissions. SECURITY INVOKER — relies on the caller already having read access via their own RLS grants.';
