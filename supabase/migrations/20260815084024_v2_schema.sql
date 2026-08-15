-- ============================================================================
-- WeCode v2 schema
--
-- Replaces the empty v1 prototype schema (public.users / public.user_secrets,
-- both 0 rows) entirely. See docs/SCHEMA.md for the full design rationale;
-- this file is the executable source of truth, that doc is the readable one.
--
-- Ordering note: table DDL is grouped first per entity, but the two
-- SECURITY DEFINER helper functions (is_room_member / is_room_host) are
-- deferred until after both `rooms` and `room_participants` exist, since a
-- `language sql` function is validated against real tables at creation time
-- — referencing a not-yet-created table fails immediately, not lazily.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Drop v1 objects. Both tables were confirmed empty (0 rows) before this ran.
-- ----------------------------------------------------------------------------
drop table if exists public.user_secrets cascade;
drop table if exists public.users cascade;

-- ============================================================================
-- users — one row per WeCode account, keyed to LeetCode's numeric user ID.
-- No email, no password: syncing a LeetCode session is the entire login flow.
-- ============================================================================
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  leetcode_id text not null unique,
  leetcode_username text not null,
  display_name text,
  avatar_url text,
  is_house_account boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is
  'WeCode accounts. leetcode_id is LeetCode''s stable numeric user ID (not the mutable username) — the real identity key.';
comment on column public.users.is_house_account is
  'True only for the single shared account Guest/Demo Mode (Epic 10) proxies submissions through.';

alter table public.users enable row level security;

create policy "users are viewable by any authenticated user"
  on public.users for select
  to authenticated
  using (true);

create policy "users can update their own row"
  on public.users for update
  to authenticated
  using (auth.uid() = id);

-- ============================================================================
-- user_credentials — encrypted LeetCode session, one-to-one with users.
-- Ciphertext only: encryption/decryption happens at the application layer
-- (see ARCHITECTURE.md), never in SQL. This table never stores plaintext.
-- ============================================================================
create table public.user_credentials (
  user_id uuid primary key references public.users (id) on delete cascade,
  leetcode_session_ciphertext text,
  leetcode_csrf_ciphertext text,
  synced_via text check (synced_via in ('extension', 'manual')),
  session_status text not null default 'valid' check (session_status in ('valid', 'stale')),
  updated_at timestamptz not null default now()
);

comment on table public.user_credentials is
  'Ciphertext only. Encrypted/decrypted at the application layer, never in SQL. Epic 01, Story 4.';

alter table public.user_credentials enable row level security;

create policy "users manage their own credentials"
  on public.user_credentials for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================================
-- rooms — a container for one hangout. Ephemeral: not a standing group.
-- (Table only here; RLS/policies come after the helper functions below.)
-- ============================================================================
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  host_user_id uuid not null references public.users (id) on delete cascade,
  invite_code text not null unique,
  status text not null default 'open' check (status in ('open', 'closed')),
  participant_cap integer not null default 20,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

comment on table public.rooms is
  'Invite-code join, no public browsing. Looking a room up by invite_code before you''re a member happens via a service-role Route Handler with an explicit check (see ARCHITECTURE.md), not via RLS — RLS here only ever grants read access to existing members/host, so it can''t be used to enumerate rooms.';

-- ============================================================================
-- room_participants — membership, with soft removal (removed_at) so chat/
-- leaderboard history stays attributable after a kick.
-- (Table only here; RLS/policies come after the helper functions below.)
-- ============================================================================
create table public.room_participants (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (room_id, user_id)
);

comment on table public.room_participants is
  'Participant cap and room-status ("is this room open") checks are enforced in the joining Server Action, not here — RLS covers row ownership/visibility, not business rules. See ARCHITECTURE.md''s DAL section.';

-- ============================================================================
-- Membership-check helpers (SECURITY DEFINER, narrow, read-only predicates).
-- Every room-scoped table's RLS policy is built on these two functions rather
-- than inlining a self-referencing subquery on room_participants, which would
-- otherwise recurse into RLS evaluation on itself. Defined here, now that
-- both `rooms` and `room_participants` exist.
-- ============================================================================
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.room_participants
    where room_id = p_room_id and user_id = auth.uid() and removed_at is null
  );
$$;

create or replace function public.is_room_host(p_room_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.rooms
    where id = p_room_id and host_user_id = auth.uid()
  );
$$;

-- ============================================================================
-- rooms: RLS + policies (now that the helper functions exist)
-- ============================================================================
alter table public.rooms enable row level security;

create policy "members and host can view their room"
  on public.rooms for select
  to authenticated
  using (host_user_id = auth.uid() or public.is_room_member(id));

create policy "authenticated users can create rooms"
  on public.rooms for insert
  to authenticated
  with check (host_user_id = auth.uid());

create policy "hosts manage their own rooms"
  on public.rooms for update
  to authenticated
  using (host_user_id = auth.uid());

-- ============================================================================
-- room_participants: RLS + policies
-- ============================================================================
alter table public.room_participants enable row level security;

create policy "room members can view the roster"
  on public.room_participants for select
  to authenticated
  using (public.is_room_member(room_id) or public.is_room_host(room_id));

create policy "users can join a room for themselves"
  on public.room_participants for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "hosts can remove participants"
  on public.room_participants for update
  to authenticated
  using (public.is_room_host(room_id));

-- ============================================================================
-- sessions — a timed, multi-problem contest run inside a room.
-- ============================================================================
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  created_by uuid not null references public.users (id),
  preset text not null check (preset in ('warm_up', 'balanced', 'challenge', 'gauntlet')),
  duration_seconds integer not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  ended_at timestamptz
);

comment on table public.sessions is
  'ends_at is the planned deadline (started_at + duration); ended_at is when it actually ended (timer expiry or host-early-end), null while active. Epic 05.';

alter table public.sessions enable row level security;

create policy "room members and host can view sessions"
  on public.sessions for select
  to authenticated
  using (public.is_room_member(room_id) or public.is_room_host(room_id));

create policy "hosts manage sessions in their room"
  on public.sessions for all
  to authenticated
  using (public.is_room_host(room_id))
  with check (public.is_room_host(room_id));

-- ============================================================================
-- session_problems — the randomly-selected problems for one session, snap-
-- shotted at selection time (title/difficulty cached independent of LeetCode's
-- live catalog, since we only need a stable record for scoring/history).
-- ============================================================================
create table public.session_problems (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  leetcode_slug text not null,
  leetcode_title text not null,
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  position integer not null,
  unique (session_id, position),
  unique (session_id, leetcode_slug)
);

comment on table public.session_problems is
  'Anti-repeat selection (Epic 05, Story 2) is a query over this table filtered to session_id IN (select id from sessions where room_id = ...) — no separate tracking table needed.';

alter table public.session_problems enable row level security;

create policy "room members and host can view session problems"
  on public.session_problems for select
  to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = session_problems.session_id
        and (public.is_room_member(s.room_id) or public.is_room_host(s.room_id))
    )
  );

create policy "hosts populate problems for their own sessions"
  on public.session_problems for insert
  to authenticated
  with check (
    exists (
      select 1 from public.sessions s
      where s.id = session_problems.session_id and public.is_room_host(s.room_id)
    )
  );

-- ============================================================================
-- submissions — every attempt, not just the accepted ones (needed to count
-- wrong-submission penalties). Readable by the whole room so results/break-
-- downs (Epic 06, Story 4) can show everyone, not just your own attempts.
-- ============================================================================
create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  session_problem_id uuid not null references public.session_problems (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  language text not null check (language in ('python3', 'java', 'cpp', 'javascript', 'go', 'c')),
  leetcode_submission_id text,
  verdict text not null default 'pending'
    check (verdict in ('pending', 'accepted', 'wrong_answer', 'runtime_error', 'time_limit_exceeded', 'compile_error', 'other')),
  submitted_at timestamptz not null default now(),
  judged_at timestamptz
);

create index submissions_session_problem_user_idx
  on public.submissions (session_problem_id, user_id, submitted_at);

alter table public.submissions enable row level security;

create policy "room members and host can view all submissions in their room"
  on public.submissions for select
  to authenticated
  using (
    exists (
      select 1 from public.session_problems sp
      join public.sessions s on s.id = sp.session_id
      where sp.id = submissions.session_problem_id
        and (public.is_room_member(s.room_id) or public.is_room_host(s.room_id))
    )
  );

create policy "users can only submit as themselves"
  on public.submissions for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.session_problems sp
      join public.sessions s on s.id = sp.session_id
      where sp.id = submissions.session_problem_id
        and (public.is_room_member(s.room_id) or public.is_room_host(s.room_id))
    )
  );

-- ============================================================================
-- chat_messages — room-scoped, soft-deletable for host moderation (Epic 07).
-- ============================================================================
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  body text not null check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index chat_messages_room_created_idx
  on public.chat_messages (room_id, created_at);

alter table public.chat_messages enable row level security;

create policy "room members and host can view chat"
  on public.chat_messages for select
  to authenticated
  using (public.is_room_member(room_id) or public.is_room_host(room_id));

create policy "room members and host can post chat"
  on public.chat_messages for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and (public.is_room_member(room_id) or public.is_room_host(room_id))
  );

create policy "message owner or host can soft-delete a message"
  on public.chat_messages for update
  to authenticated
  using (user_id = auth.uid() or public.is_room_host(room_id));

-- ============================================================================
-- scoring_config — tunable constants for the leaderboard formula (Epic 06,
-- Story 5): editable without a code deploy. Seeded with the proposed default.
-- ============================================================================
create table public.scoring_config (
  key text primary key,
  value numeric not null
);

comment on table public.scoring_config is
  'The formula in compute_leaderboard() below is a proposed default (Epic 06) — tune these values, not the SQL, unless the formula shape itself changes.';

alter table public.scoring_config enable row level security;

create policy "scoring config is readable by any authenticated user"
  on public.scoring_config for select
  to authenticated
  using (true);

insert into public.scoring_config (key, value) values
  ('base_points_easy', 100),
  ('base_points_medium', 200),
  ('base_points_hard', 300),
  ('decay_floor_pct', 0.3),
  ('wrong_submission_penalty', 10);

-- ============================================================================
-- compute_leaderboard — the per-session leaderboard, computed on demand
-- (not a materialized table) so "how it's computed" and "what it returns"
-- never drift apart. The socket.io server (Epic 11) calls this after each
-- scoring-relevant write and broadcasts the result.
--
-- Per-problem score = base_points(difficulty)
--                      * max(floor_pct, 1 - (1 - floor_pct) * elapsed/duration)
--                      - (wrong_submissions_before_accept * penalty)
-- Only a problem's *first* accepted submission counts; unsolved problems
-- contribute 0 and no penalty, matching standard ACM-style scoring.
-- ============================================================================
create or replace function public.compute_leaderboard(p_session_id uuid)
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
  sess as (
    select id, room_id, started_at, duration_seconds
    from public.sessions
    where id = p_session_id
  ),
  first_accepts as (
    select distinct on (sub.user_id, sub.session_problem_id)
      sub.user_id,
      sub.session_problem_id,
      sp.difficulty,
      sub.judged_at,
      (
        select count(*) from public.submissions earlier
        where earlier.session_problem_id = sub.session_problem_id
          and earlier.user_id = sub.user_id
          and earlier.verdict <> 'accepted'
          and earlier.submitted_at < sub.submitted_at
      ) as wrong_before
    from public.submissions sub
    join public.session_problems sp on sp.id = sub.session_problem_id
    where sub.verdict = 'accepted'
      and sp.session_id = p_session_id
    order by sub.user_id, sub.session_problem_id, sub.judged_at asc
  ),
  scored as (
    select
      fa.user_id,
      fa.session_problem_id,
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
              extract(epoch from (fa.judged_at - sess.started_at)) / sess.duration_seconds
            )
          )
        - (fa.wrong_before * cfg.penalty)
      ) as problem_score
    from first_accepts fa
    cross join cfg
    cross join sess
  )
  select
    u.id as user_id,
    u.display_name,
    u.avatar_url,
    coalesce(sum(scored.problem_score), 0) as total_score,
    count(scored.session_problem_id)::int as problems_solved,
    max(scored.judged_at) as last_accepted_at
  from public.users u
  left join scored on scored.user_id = u.id
  where u.id in (
    select rp.user_id from public.room_participants rp
    where rp.room_id = (select room_id from sess) and rp.removed_at is null
  )
  group by u.id, u.display_name, u.avatar_url
  order by total_score desc, last_accepted_at asc nulls last;
$$;

comment on function public.compute_leaderboard(uuid) is
  'SECURITY INVOKER — relies on the caller (or the room-scoped connection used by the Epic 11 socket server) already having read access to submissions/session_problems/sessions via their own RLS grants.';
