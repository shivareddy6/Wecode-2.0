# WeCode v2 — Database Schema

This documents the schema in `supabase/migrations/` in prose. Those migration files are the source of truth — this doc explains the *why* behind their shape and should be updated alongside them, not instead of them.

## Tables

**`users`** — one row per WeCode account. Identity is LeetCode-only (see `ARCHITECTURE.md`): no email, no password. `leetcode_id` is LeetCode's stable numeric user ID and is what accounts are actually keyed by — `leetcode_username` is stored for display only, since usernames can change on LeetCode but the numeric ID can't. `is_house_account` flags the single shared account Guest/Demo Mode (Epic 10) proxies submissions through; everything else treats it as an ordinary user.

**`user_credentials`** — one-to-one with `users`. Stores the encrypted LeetCode session cookie and CSRF token. These columns are ciphertext only — encryption and decryption both happen at the application layer (inside the submission-proxy Route Handler), never in SQL. `session_status` flips to `stale` when a submission attempt fails with a LeetCode auth-rejection, driving the "reconnect" UI prompt (Epic 01, Story 3) without touching the rest of the user's WeCode session.

**`rooms`** — a container for one hangout (ephemeral, not a standing group — see `PRD.md`). Joinable only by invite code, never by browsing: the RLS policy on this table only ever grants read access to existing members or the host, which means it *cannot* be used to enumerate rooms. Looking a room up by its invite code — necessarily, before you're a member yet — happens through a service-role lookup (`lib/dal.ts`'s `lookupRoomForJoin`) with an explicit application-level check, called from the join Server Action (`app/rooms/actions.ts`'s `joinRoom`) rather than a Route Handler, per ARCHITECTURE.md's Server-Action-for-your-own-UI-mutations rule — the same service-role pattern used everywhere else that bypass exists (see the Authorization section of `ARCHITECTURE.md`). Participant caps and "is this room still open" checks are enforced in that same joining Server Action, not in the database.

**`room_participants`** — membership, one row per (room, user). Removal is soft (`removed_at`, not a deleted row) so chat and leaderboard history stay attributable to a real person even after a host kicks them (Epic 04, Story 4).

**Rounds live directly on `rooms`, not in a separate history table.** Earlier this schema had `sessions`/`session_problems` tables — a growing, permanently-retained history of every round a room ever ran. That was reconsidered and replaced (see "Room-centric rounds" below) once the actual product requirements were pinned down: no history-browsing UI, a leaderboard that only ever needs the *current* round, and chat that's room-scoped regardless — the only thing that genuinely needs to survive a round ending is the anti-repeat memory, which doesn't need a relational history to exist. `rooms` therefore carries the current round's state directly: `current_problems` (jsonb array of `{slug, title, difficulty}`, wholesale-replaced each round — see `start_room_round()`), `round_started_at`/`round_duration_seconds`/`round_preset`/`round_status`, and `used_leetcode_slugs` (text[], permanent, append-only — every slug this room has ever run, across all rounds, for anti-repeat).

**`submissions`** — every attempt, not only accepted ones, because the scoring formula needs to count wrong attempts before an eventual accept. Readable by every participant in the room, not just the submitter, since final standings show everyone's per-problem breakdown (Epic 06, Story 4). Keyed by `room_id` + `problem_slug` directly (no `session_problems` hop). `difficulty` is denormalized onto the row at insert time — looked up server-side from `rooms.current_problems`, never client-supplied — because `current_problems` is mutable and wholesale-replaced every round, so a submission can't safely re-derive its own problem's difficulty from it after the round has moved on. `is_out_of_contest` is denormalized the same way and for the same reason: a submission made after the round's deadline (or after the host ends it early) is still sent to LeetCode's real judge — nothing about *submitting* is gated — but it's flagged so `compute_leaderboard()` can exclude it entirely (see below) and so it can be shown as distinct wherever submissions are displayed (the solve screen; chat, later — see `epics/07-chat.md`'s Story 5).

## Room-centric rounds: why there's no session history table

A room is a persistent group; a round (what used to be modeled as a `sessions` row) is one bounded, timed occurrence of problems within it. Rounds run sequentially, never concurrently — at most one is ever live per room. That's one-to-one only at a single instant, though: across a room's lifetime, many rounds happen, one after another, which is why it's tempting to model it as a growing one-to-many history table. Whether that history should actually be *retained* is a separate question from whether rounds are conceptually repeated — and here, none of it is:

- No UI ever browses past rounds (explicitly out of scope).
- The leaderboard only ever shows the *current* round (`compute_leaderboard(room_id)` — not session-scoped, room-scoped, and safe by construction: submissions are cleared on every round transition, so "all of a room's current submissions" already *is* "this round's submissions," no extra filtering needed).
- Chat spans rounds regardless (`chat_messages.room_id`, unaffected by round transitions either way).
- The only requirement needing *anything* to survive a round ending is anti-repeat — and that only needs a slug, not a full historical row (duration, timestamps, snapshotted title, per-round submissions).

`start_room_round(room_id, problems, duration_seconds, preset)` is the one atomic transition point, wrapped in a single `plpgsql` function so all of it commits or fails together rather than as separate app-layer round trips: it snapshots the outgoing round's problem slugs into `rooms.used_leetcode_slugs` (raising an exception if any of the *new* round's slugs were already used — the anti-repeat rule enforced at the source, not just hoped for in application code), deletes the outgoing round's `submissions` outright (abandoning anything still mid-judging is an accepted tradeoff — the product owner's stated position is that nothing about a round matters once the room has moved past it), and installs the new round's state.

The tell that this isn't just "deleting history for its own sake": `user_credentials` in this same schema *is* modeled as genuinely one-to-one with `users` (`user_id` as its own primary key, no surrogate id, because a user only ever has exactly one credentials row, replaced in place). Rounds aren't that — they're a real one-to-many relationship over a room's lifetime — but *retaining* that history was never required by anything actually being built, so the schema doesn't carry it.

**`chat_messages`** — room-scoped, soft-deletable (`deleted_at`) so a host can moderate (Epic 07, Story 3) without destroying the row outright.

**`scoring_config`** — the tunable constants the leaderboard formula reads (base points per difficulty, the decay floor percentage, the wrong-submission penalty). Editable by updating rows, not by redeploying code (Epic 06, Story 5). Seeded with the proposed defaults from the PRD: 100/200/300 base points for easy/medium/hard, a 30% decay floor, a 10-point penalty per wrong submission.

## Authorization model

Two layers, matching the DAL discussion in `ARCHITECTURE.md`:

- **RLS enforces row ownership and visibility.** A participant can read their room's sessions, problems, submissions, and chat; a non-participant can't, full stop, regardless of what their own application code does or forgets to check.
- **Business rules live in application code, not RLS.** Room capacity limits, "is this room open," and invite-code resolution are checked in Server Actions/Route Handlers, not as database constraints — RLS is good at "can you see this row," not at "is now a valid time to create this row."

One structural note: several policies reference two small `SECURITY DEFINER` helper functions, `is_room_member(room_id)` and `is_room_host(room_id)`, instead of inlining a subquery directly against `room_participants` or `rooms`. This isn't a bypass of the authorization model — it's a standard Postgres RLS pattern to avoid a policy on a table recursively triggering RLS evaluation against that same table while checking itself. Every other room-scoped table's policies are built on these same two functions, so there's exactly one place membership/host logic is defined, not one per table.

A third `SECURITY DEFINER` function, `finalize_expired_round(room_id)` (Epic 05, Story 5), follows the same two conventions below but for a different reason than `is_room_member`/`is_room_host`: it's not a recursion workaround, it's a deliberate RLS bypass. `rooms`' own UPDATE policy is host-only ("hosts manage their own rooms"), but *any* room member should be able to flip an expired round's `round_status` to `'ended'` — whoever happens to load the room page or attempt a late submission first, not just the host — so the function has to step outside that policy on purpose. It's idempotent (only writes when `round_status = 'active'` and the deadline has actually passed) and is the lazy-finalization half of "submissions after the deadline are rejected" — the actual rejection in `app/api/submissions/route.ts` checks the timestamps directly and doesn't depend on this having run first; this only exists so the row itself converges to `'ended'` for anyone just looking at it. `start_room_round`, by contrast, stays `SECURITY INVOKER` with an explicit `is_room_host` check inside — it only needs the host's own RLS-granted UPDATE access, since only the host ever calls it.

Two things worth knowing if you add another `SECURITY DEFINER` function to this schema: pin its `search_path` explicitly (an unset one lets a role with schema-creation rights shadow an unqualified object name), and grant `EXECUTE` explicitly to `authenticated` rather than relying on the default — Postgres grants `EXECUTE` to `PUBLIC` at creation time by default, which `anon` inherits regardless of anything revoked from `anon` specifically; the only way to actually exclude `anon` is to revoke from `PUBLIC` and grant back to the roles that need it.

## The leaderboard: a function, not a table

There's deliberately no `leaderboard_scores` table. `compute_leaderboard(room_id)` computes the ranking on demand from `submissions` + `rooms.current_problems`/`round_started_at`/`round_duration_seconds` + `scoring_config`, so "how the leaderboard is computed" and "what it currently shows" can never drift apart the way a separately-maintained scores table could. The Epic 11 socket server calls this function and broadcasts the result after every scoring-relevant write, per the coordinated write-then-broadcast requirement in that epic.

`compute_leaderboard()` also excludes every `is_out_of_contest` submission outright — both from a problem's own score and from the wrong-attempt penalty count of a later in-contest accept on the same problem — rather than filtering by timestamp itself. That's a deliberate design choice, not an oversight: filtering by the flag means the function never has to re-derive "was this in the round's window" from timestamps that could be interpreted two ways (e.g. the second the deadline hit vs. a second later); the one place that decision gets made is at insert time (`app/api/submissions/route.ts`), same as `difficulty`.

The formula implemented is the **proposed default** from Epic 06, Story 1 — not a specified requirement:

```
per-problem score = base_points(difficulty)
                     × max(floor_pct, 1 − (1 − floor_pct) × elapsed_time / session_duration)
                     − (wrong_submissions_before_accept × penalty)
```

Only a problem's first accepted submission counts; a problem never solved contributes 0 points and no penalty (standard ACM-style convention). If this formula doesn't feel right once it's live, the fix is almost always editing `scoring_config` rows, not the SQL function — the constants were separated from the shape specifically so tuning doesn't require a migration.
