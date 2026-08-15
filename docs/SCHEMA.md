# WeCode v2 — Database Schema

This documents `supabase/migrations/20260815084024_v2_schema.sql` in prose. That migration file is the source of truth — this doc explains the *why* behind its shape and should be updated alongside it, not instead of it. It replaces the v1 prototype's `public.users`/`public.user_secrets` schema entirely (both were confirmed empty — 0 rows — before the switch, so nothing was migrated or lost).

## Tables

**`users`** — one row per WeCode account. Identity is LeetCode-only (see `ARCHITECTURE.md`): no email, no password. `leetcode_id` is LeetCode's stable numeric user ID and is what accounts are actually keyed by — `leetcode_username` is stored for display only, since usernames can change on LeetCode but the numeric ID can't. `is_house_account` flags the single shared account Guest/Demo Mode (Epic 10) proxies submissions through; everything else treats it as an ordinary user.

**`user_credentials`** — one-to-one with `users`. Stores the encrypted LeetCode session cookie and CSRF token. These columns are ciphertext only — encryption and decryption both happen at the application layer (inside the submission-proxy Route Handler), never in SQL. `session_status` flips to `stale` when a submission attempt fails with a LeetCode auth-rejection, driving the "reconnect" UI prompt (Epic 01, Story 3) without touching the rest of the user's WeCode session.

**`rooms`** — a container for one hangout (ephemeral, not a standing group — see `PRD.md`). Joinable only by invite code, never by browsing: the RLS policy on this table only ever grants read access to existing members or the host, which means it *cannot* be used to enumerate rooms. Looking a room up by its invite code — necessarily, before you're a member yet — happens through a service-role Route Handler with an explicit application-level check, the same pattern used everywhere else a service-role path exists (see the Authorization section of `ARCHITECTURE.md`). Participant caps and "is this room still open" checks are enforced in the joining Server Action, not in the database.

**`room_participants`** — membership, one row per (room, user). Removal is soft (`removed_at`, not a deleted row) so chat and leaderboard history stay attributable to a real person even after a host kicks them (Epic 04, Story 4).

**`sessions`** — a timed, multi-problem contest inside a room (Epic 05). `ends_at` is the planned deadline; `ended_at` is when it actually ended (timer expiry or the host ending it early), and stays `null` while the session is active. `preset` is one of the four fixed difficulty presets from the PRD (`warm_up`, `balanced`, `challenge`, `gauntlet`) — there's no free-form difficulty/topic filtering to model.

**`session_problems`** — the problems randomly selected for one session, snapshotted (title/difficulty cached) at selection time rather than re-fetched live from LeetCode on every read. The anti-repeat rule ("don't reuse a problem already used in this room," Epic 05 Story 2) is just a query filtered to `session_id IN (select id from sessions where room_id = ...)` — no separate tracking table needed.

**`submissions`** — every attempt, not only accepted ones, because the scoring formula needs to count wrong attempts before an eventual accept. Readable by every participant in the room, not just the submitter, since final standings show everyone's per-problem breakdown (Epic 06, Story 4).

**`chat_messages`** — room-scoped, soft-deletable (`deleted_at`) so a host can moderate (Epic 07, Story 3) without destroying the row outright.

**`scoring_config`** — the tunable constants the leaderboard formula reads (base points per difficulty, the decay floor percentage, the wrong-submission penalty). Editable by updating rows, not by redeploying code (Epic 06, Story 5). Seeded with the proposed defaults from the PRD: 100/200/300 base points for easy/medium/hard, a 30% decay floor, a 10-point penalty per wrong submission.

## Authorization model

Two layers, matching the DAL discussion in `ARCHITECTURE.md`:

- **RLS enforces row ownership and visibility.** A participant can read their room's sessions, problems, submissions, and chat; a non-participant can't, full stop, regardless of what their own application code does or forgets to check.
- **Business rules live in application code, not RLS.** Room capacity limits, "is this room open," and invite-code resolution are checked in Server Actions/Route Handlers, not as database constraints — RLS is good at "can you see this row," not at "is now a valid time to create this row."

One structural note: several policies reference two small `SECURITY DEFINER` helper functions, `is_room_member(room_id)` and `is_room_host(room_id)`, instead of inlining a subquery directly against `room_participants` or `rooms`. This isn't a bypass of the authorization model — it's a standard Postgres RLS pattern to avoid a policy on a table recursively triggering RLS evaluation against that same table while checking itself. Every other room-scoped table's policies are built on these same two functions, so there's exactly one place membership/host logic is defined, not one per table.

## The leaderboard: a function, not a table

There's deliberately no `leaderboard_scores` table. `compute_leaderboard(session_id)` computes the ranking on demand from `submissions` + `session_problems` + `scoring_config`, so "how the leaderboard is computed" and "what it currently shows" can never drift apart the way a separately-maintained scores table could. The Epic 11 socket server calls this function and broadcasts the result after every scoring-relevant write, per the coordinated write-then-broadcast requirement in that epic.

## Hardening notes, post-migration

Running Supabase's security advisor after the initial migration caught two real issues, both fixed in follow-up migrations (`v2_schema_cleanup.sql`, `v2_schema_hardening.sql`, `v2_schema_fix_function_grants.sql`):

- **A live v1 trigger would have broken every future signup.** `on_auth_user_created` on `auth.users` still called the old `handle_new_user()`, which inserted into `public.users` using the v1 shape (`email`, no `leetcode_id`). Dropping the v1 tables didn't remove it, since a trigger on `auth.users` isn't a dependent of `public.users` the way its own trigger was. This is now dropped outright — v2 populates `public.users` from application code during LeetCode sync, not a database trigger.
- **Revoking a specific role's grant doesn't override a broader `PUBLIC` grant.** `is_room_member`/`is_room_host` got `EXECUTE` granted to `PUBLIC` by default at creation. `revoke execute ... from anon` looked like it worked (confirmed by the advisor going quiet), but `anon` was still covered by the untouched `PUBLIC` grant — the advisor's report appears to cache/lag rather than reflect live state, so the fix was verified directly with `has_function_privilege()`, not by re-reading the advisor. The correct fix is revoking from `PUBLIC` and granting back explicitly to `authenticated` only, which is what actually landed.

The formula implemented is the **proposed default** from Epic 06, Story 1 — not a specified requirement:

```
per-problem score = base_points(difficulty)
                     × max(floor_pct, 1 − (1 − floor_pct) × elapsed_time / session_duration)
                     − (wrong_submissions_before_accept × penalty)
```

Only a problem's first accepted submission counts; a problem never solved contributes 0 points and no penalty (standard ACM-style convention). If this formula doesn't feel right once it's live, the fix is almost always editing `scoring_config` rows, not the SQL function — the constants were separated from the shape specifically so tuning doesn't require a migration.
