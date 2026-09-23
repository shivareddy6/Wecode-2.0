# Epic 06 — Leaderboard & Scoring

**Goal:** A live, per-session leaderboard that rewards solving fast and cleanly. Resets at the start of every new session — see `PRD.md` for why cumulative room-wide totals are explicitly out of scope.

**Note:** the scoring formula below is a proposed default, not something separately specified — flag it for a look before launch if it doesn't feel right once you see it in action.

---

### Story 1 — Scoring formula
As the system, I want to compute a per-problem score for each accepted solution using a time-decay-plus-penalty formula, so faster, cleaner solves rank higher.

- Proposed default:
  - Each problem has a base point value from its LeetCode difficulty (e.g. Easy 100 / Medium 200 / Hard 300 — exact values configurable).
  - Points decay from that base value as session time elapses, down to a floor (e.g. never below 30% of base) so a late Accepted solution still scores something.
  - Each non-accepted submission on a problem before its eventual Accepted costs a flat penalty (e.g. 10 points), applied only if the problem is eventually solved — matching the standard ACM-style convention of no penalty for problems never solved.
- Acceptance criteria:
  - All constants (base points per difficulty, decay rate, floor percentage, penalty per wrong submission) are configurable without a code change.
  - A problem never attempted, or attempted but never solved by session end, contributes 0 points and no penalty.
  - A submission flagged `is_out_of_contest` (Epic 05, Story 5 — made after the round's deadline) contributes 0 points and no penalty, regardless of verdict, the same as a problem never attempted.

**Status: Done.** The out-of-contest exclusion was already implemented and verified — `compute_leaderboard()` (`supabase/migrations/20260906100000_out_of_contest_submissions.sql`) filters `is_out_of_contest` rows out of both the score and the wrong-attempt penalty count. The function itself and the configurable constants in `scoring_config` predate this epic being picked up — see `docs/SCHEMA.md`'s "The leaderboard: a function, not a table" section.

**Reconciled 2026-09-23 — a kicked participant's history no longer vanishes from the leaderboard.** `docs/SCHEMA.md` documents removal as soft specifically "so chat and leaderboard history stay attributable to a real person even after a host kicks them," but `compute_leaderboard()` and `compute_leaderboard_breakdown()` both filtered their roster to `removed_at is null` — a kicked participant's entire score/breakdown history disappeared from both views the moment they were removed, even though chat (including their Story 5 submission-activity entries) kept them visible. Confirmed with the user (`AskUserQuestion`) as a real inconsistency against the schema's own documented contract, not a new feature — fixed rather than documented away. `supabase/migrations/20260923100000_leaderboard_includes_removed.sql` (applied live via the Supabase MCP, required a `DROP FUNCTION` first on both since adding a column is a return-type change) widens both functions' roster to every participant the room has ever had, adding an `is_removed` output column — a kicked participant's row/history stays visible but flagged, the same "visible, not hidden" precedent `solved_out_of_contest` already set. `LiveLeaderboard`/`ProblemBreakdown` (`apps/web/components/`) both render a `(removed)` tag next to a flagged row's name. `database.types.ts` regenerated and synced to both copies. Verified via a new `npm run verify:leaderboard-kicked-history -w web` (3/3): a kicked participant's rollup score and breakdown row both survive with `is_removed = true`, while the active host's own row stays unflagged. Re-ran all other verify scripts after — no regressions.

**Host-competes decision, resolved:** the host is no different from any other user except for the start/end/restart-round powers — they compete on the leaderboard by default. First fixed narrowly (`supabase/migrations/20260906120000_host_competes_on_leaderboard.sql`) by unioning `rooms.host_user_id` into `compute_leaderboard()`'s roster — but that only fixed the leaderboard, and the same "forget the union, host silently drops out" risk would've resurfaced in every future room-scoped feature (participant list, chat presence). Superseded by a schema-level fix (`supabase/migrations/20260906130000_host_is_a_participant.sql`, see `docs/SCHEMA.md`'s "Room membership: the host is a participant too"): the host now gets a real `room_participants` row from `create_room()`, so `compute_leaderboard()` is back to a plain, un-unioned read of that table — correct by construction, not by remembering to compose two sources. A plain server-rendered leaderboard view calls this function — `apps/web/app/rooms/[code]/leaderboard/page.tsx`, linked from the room page — matching Story 2's note that the static view comes first, socket push later.

### Story 2 — Live leaderboard updates
As a participant, I want the leaderboard to update live as people solve problems, so the competition feels real-time.

- Acceptance criteria:
  - Leaderboard updates are pushed via the socket.io server (Epic 11) immediately after the score is written to the scoring view/table, not on a polling interval.
  - The UI reflects a new score within roughly a second or two of an Accepted verdict, without a manual refresh.

**Status: Done.** `app/api/submissions/[id]/status/route.ts` — the route that writes a submission's final verdict once LeetCode finishes judging it — now recomputes `compute_leaderboard()` and POSTs the fresh rows to the realtime server's `/internal/broadcast` (`lib/realtime/broadcast.ts`) right after that write, on the same code path (event `leaderboard:update`, channel `room:<roomId>`). `apps/web/app/rooms/[code]/leaderboard/page.tsx` still server-renders the initial rows, but now hands them to a new client component (`components/live-leaderboard.tsx`) that opens a `socket.io-client` connection (auth via the browser's current Supabase access token), joins the room channel, and replaces the row set in place whenever a push arrives — no polling. Verified end-to-end against real scratch Supabase fixtures + a real socket.io-client (`apps/web/scripts/verify-leaderboard-push.ts`, `npm run verify:leaderboard-push -w web`, self-cleaning): join → accepted-submission insert → recompute → broadcast → client receipt, 3/3 checks passing. Not covered by that script (unchanged, pre-existing code): the actual LeetCode judging call itself, which needs a real LeetCode session.

### Story 3 — Per-session reset
As a participant, I want the leaderboard to reset at the start of each new session, so every round starts fair.

- Acceptance criteria:
  - Starting a new session (Epic 05, Story 7) clears the visible leaderboard and begins scoring from zero for that session.

**Status: Done, by construction.** `start_room_round()` deletes the outgoing round's `submissions` outright (see `docs/SCHEMA.md`'s "Room-centric rounds"), and `compute_leaderboard()` only ever reads a room's current submissions — so a new round already scores from zero without any leaderboard-specific reset logic needed.

### Story 4 — Final standings and breakdown
As a participant, I want to see final standings and a per-problem breakdown once a round ends, so I can review how it went.

- Acceptance criteria:
  - After the round ends (automatic or early), the room's leaderboard keeps showing final rank, total score, and a per-problem score/attempt-count breakdown for each participant, scoped to the *current* round's problems only.
  - No separate archival/history view — round history is out of scope (Story 6) and nothing is retained once the room itself closes (Epic 04, Story 5).
  - A submission made after the round's deadline is still visible in the per-problem breakdown for interest, clearly marked as out-of-contest (Epic 05, Story 5) and contributing 0 points — never silently scored, never hidden entirely.

**Product decision, resolved 2026-09-17:** dropped the original "accessible from the room's session history" AC — this doesn't need a dedicated final-standings page. It's the same leaderboard view Story 2 already live-updates; it just needs to keep rendering after the round ends instead of implying it's only relevant while `round_status = 'active'`. Chat (Epic 07, Story 1's "messages persist for the life of the room") is what actually carries a sense of "history" across rounds within an open room — the leaderboard intentionally resets per round (Story 3) and isn't meant to double as an archive, so there's no real conflict with Story 6 or Epic 04 Story 5's "nothing retained" stance on room closure.

**Status: Done.** The "visible after the round ends" part was already true without any change, confirmed by reading `compute_leaderboard(p_room_id)`'s definition directly: it has no `round_status` filter at all, so `apps/web/app/rooms/[code]/leaderboard/page.tsx` already kept showing a room's current standings after the round ends. What was missing — the per-problem score/attempt-count breakdown, with a late accept visible-but-marked rather than hidden — is now `compute_leaderboard_breakdown()` (`supabase/migrations/20260917090000_leaderboard_breakdown.sql`), a second RPC alongside `compute_leaderboard()` rather than a change to it: it cross-joins each room's `current_problems` against its roster and returns one row per (participant, problem) with a `status` of `solved` / `solved_out_of_contest` / `not_attempted` plus `problem_score`/`attempt_count` — an out-of-contest accept gets `solved_out_of_contest` with `problem_score = 0`, satisfying the "visible, marked, contributing 0 points, never hidden" AC directly instead of by omission the way `compute_leaderboard()` handles it. Rendered by a new `apps/web/components/problem-breakdown.tsx`, grouped by participant (in the same rank order as the rollup above it) on the same leaderboard page — not live-pushed like Story 2's totals, since this is meant to be read as much after a round ends as during it; it just re-renders on the page's normal server-render cycle. Verified end-to-end against real scratch Supabase fixtures (`apps/web/scripts/verify-leaderboard-breakdown.ts`, `npm run verify:leaderboard-breakdown -w web`, self-cleaning): an in-contest solve after one wrong attempt, a never-attempted problem, and an out-of-contest accept all report the correct `status`/`problem_score`/`attempt_count` — 4/4 checks passing.

### Story 5 — Configurable scoring constants
As a host, I want the scoring formula's constants to be tunable without a code deployment, so the format can be adjusted over time based on how it feels in practice.

- Acceptance criteria:
  - Base points, decay rate, floor, and penalty values are stored as configuration (not hardcoded), editable centrally.

**Status: Done.** `scoring_config` (see `docs/SCHEMA.md`) predates this epic being picked up — `compute_leaderboard()` reads its constants from there, not hardcoded values, and editing a row doesn't require a migration.
