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

**Status: Partial.** The out-of-contest exclusion is already implemented and verified — `compute_leaderboard()` (`supabase/migrations/20260906100000_out_of_contest_submissions.sql`) filters `is_out_of_contest` rows out of both the score and the wrong-attempt penalty count. The rest of this story (the function itself, the configurable constants in `scoring_config`) predates this epic being picked up — see `docs/SCHEMA.md`'s "The leaderboard: a function, not a table" section — but nothing yet calls `compute_leaderboard()` from application code; there's no leaderboard UI.

**Known gap to resolve when this story is actually picked up:** `compute_leaderboard()`'s final `users` filter only includes rows from `room_participants` (`where u.id in (select rp.user_id from room_participants where room_id = ... and removed_at is null)`), and the host never gets a `room_participants` row — that's by design elsewhere (`is_room_host` is a separate check from membership; see `docs/SCHEMA.md`'s Authorization model). Net effect: a host's own submissions currently can't appear on the leaderboard at all, no matter what they solve. This isn't just a one-line bug fix — it's a real product question worth exploring before deciding: does the host compete in their own room by default (then the function needs to include `rooms.host_user_id` alongside `room_participants`, e.g. a `union`), or is the host meant to be a neutral organizer who doesn't show up on standings at all (then the current behavior might actually be correct, and the "gap" is really just that it's undocumented/unintentional-looking)? There's also a middle option — host competes only if they also explicitly join as a participant. Explore the options and decide deliberately when this story is built, rather than defaulting to whichever behavior falls out of the current query.

### Story 2 — Live leaderboard updates
As a participant, I want the leaderboard to update live as people solve problems, so the competition feels real-time.

- Acceptance criteria:
  - Leaderboard updates are pushed via the socket.io server (Epic 11) immediately after the score is written to the scoring view/table, not on a polling interval.
  - The UI reflects a new score within roughly a second or two of an Accepted verdict, without a manual refresh.

### Story 3 — Per-session reset
As a participant, I want the leaderboard to reset at the start of each new session, so every round starts fair.

- Acceptance criteria:
  - Starting a new session (Epic 05, Story 7) clears the visible leaderboard and begins scoring from zero for that session.

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
