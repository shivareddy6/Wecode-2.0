# Epic 05 — Sessions (Contests)

**Goal:** A session is a timed, multi-problem contest run inside a room. A room can run many sessions back-to-back; each is independent (fresh problems, fresh timer, fresh leaderboard — see Epic 06).

---

### Story 1 — Start a session with a difficulty preset
As a host, I want to start a new session by picking a difficulty preset and a duration, so a fresh contest begins for everyone in the room.

- Acceptance criteria:
  - The host chooses one of four presets: Warm-up (3 Easy/1 Medium), Balanced (2 Easy/2 Medium), Challenge (1 Easy/2 Medium/1 Hard), Gauntlet (1 Easy/1 Medium/2 Hard).
  - The host sets a session duration.
  - Starting a session immediately begins the countdown for all participants.

### Story 2 — Random problem selection
As the system, I want to randomly select problems matching the chosen preset's difficulty counts when a session starts, so problem choice is fair and unpredictable.

- Acceptance criteria:
  - The selected problems are fixed for the session's duration (not re-rolled mid-session).
  - Selection avoids repeating a problem already used earlier in the same room, where enough unused problems matching the preset exist.

### Story 3 — Live countdown
As a participant, I want to see how much time is left in the current session, so I know how long I have.

- Acceptance criteria:
  - A countdown is visible throughout the session, synced closely enough across participants that "time's up" lands at effectively the same moment for everyone.

### Story 4 — Solve problems in any order
As a participant, I want to move between the session's problems freely and submit to any of them before time runs out, so I can attempt them in whatever order I prefer.

- Acceptance criteria:
  - All of a session's problems are accessible to a participant simultaneously, each backed by the Solo Solve experience (Epic 03).

### Story 5 — Automatic session end
As the system, I want a session to end automatically when its timer expires, so results become final without host intervention.

- Acceptance criteria:
  - Submissions whose judging request was made before the deadline are still counted even if the verdict resolves slightly after.
  - Submissions initiated after the deadline are rejected.
  - Once ended, the session's leaderboard is locked and final standings are computed (Epic 06).

### Story 6 — End a session early
As a host, I want to end a session before its timer runs out, so I'm not forced to wait if everyone's already finished.

- Acceptance criteria:
  - Ending early triggers the same finalization behavior as automatic expiry.

### Story 7 — Start a new session in the same room
As a host, I want to start another session in the same room after one ends, so the group can keep playing without recreating the room.

- Acceptance criteria:
  - Starting a new session while the room remains open resets the countdown and leaderboard and selects a new problem set per Story 1/2.
