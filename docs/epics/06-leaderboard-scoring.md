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

### Story 5 — Configurable scoring constants
As a host, I want the scoring formula's constants to be tunable without a code deployment, so the format can be adjusted over time based on how it feels in practice.

- Acceptance criteria:
  - Base points, decay rate, floor, and penalty values are stored as configuration (not hardcoded), editable centrally.
