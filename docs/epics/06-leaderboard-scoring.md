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

**Host-competes decision, resolved:** the host is no different from any other user except for the start/end/restart-round powers — they compete on the leaderboard by default. First fixed narrowly (`supabase/migrations/20260906120000_host_competes_on_leaderboard.sql`) by unioning `rooms.host_user_id` into `compute_leaderboard()`'s roster — but that only fixed the leaderboard, and the same "forget the union, host silently drops out" risk would've resurfaced in every future room-scoped feature (participant list, chat presence). Superseded by a schema-level fix (`supabase/migrations/20260906130000_host_is_a_participant.sql`, see `docs/SCHEMA.md`'s "Room membership: the host is a participant too"): the host now gets a real `room_participants` row from `create_room()`, so `compute_leaderboard()` is back to a plain, un-unioned read of that table — correct by construction, not by remembering to compose two sources. A plain server-rendered leaderboard view calls this function — `app/rooms/[code]/leaderboard/page.tsx`, linked from the room page — matching Story 2's note that the static view comes first, socket push later.

### Story 2 — Live leaderboard updates
As a participant, I want the leaderboard to update live as people solve problems, so the competition feels real-time.

- Acceptance criteria:
  - Leaderboard updates are pushed via the socket.io server (Epic 11) immediately after the score is written to the scoring view/table, not on a polling interval.
  - The UI reflects a new score within roughly a second or two of an Accepted verdict, without a manual refresh.

**Status: Partial.** The leaderboard view itself exists (`app/rooms/[code]/leaderboard/page.tsx`) and reflects a fresh score on the next page load/`router.refresh()`, but nothing pushes it — that's Epic 11's socket server, not built yet. Deliberate ordering, not an oversight: get the static view right first, layer the push on once Epic 11 exists.

### Story 3 — Per-session reset
As a participant, I want the leaderboard to reset at the start of each new session, so every round starts fair.

- Acceptance criteria:
  - Starting a new session (Epic 05, Story 7) clears the visible leaderboard and begins scoring from zero for that session.

**Status: Done, by construction.** `start_room_round()` deletes the outgoing round's `submissions` outright (see `docs/SCHEMA.md`'s "Room-centric rounds"), and `compute_leaderboard()` only ever reads a room's current submissions — so a new round already scores from zero without any leaderboard-specific reset logic needed.

### Story 4 — Final standings and breakdown
As a participant, I want to see final standings and a per-problem breakdown once a session ends, so I can review how the round went.

- Acceptance criteria:
  - After session end (automatic or early), a results view shows final rank, total score, and per-problem score/attempt count for each participant.
  - This view remains accessible from the room's session history (Epic 04, Story 6).
  - A problem solved out-of-contest (Epic 05, Story 5) should still be visible in the per-problem breakdown for interest — just clearly marked as not contributing to the score, not hidden entirely.

**Status: Not started.** Note: the second AC conflicts with the user's own explicit call that session history browsing (Epic 04, Story 6) is out of scope — same conflict already flagged on Epic 04, Story 5's status. When this gets built, that AC needs revisiting, not literal implementation.

### Story 5 — Configurable scoring constants
As a host, I want the scoring formula's constants to be tunable without a code deployment, so the format can be adjusted over time based on how it feels in practice.

- Acceptance criteria:
  - Base points, decay rate, floor, and penalty values are stored as configuration (not hardcoded), editable centrally.

**Status: Done.** `scoring_config` (see `docs/SCHEMA.md`) predates this epic being picked up — `compute_leaderboard()` reads its constants from there, not hardcoded values, and editing a row doesn't require a migration.
