# Epic 04 — Rooms

**Goal:** A room is the container for one hangout with friends — created, joined via a link, and eventually closed. Rooms are ephemeral: they don't persist as standing groups across unrelated future hangouts (see `PRD.md` for the reasoning).

---

### Story 1 — Create a room
As a user, I want to create a room, so I have a place to invite friends into.

- Acceptance criteria:
  - Creating a room generates a unique invite link/code.
  - The creator becomes the room's host.
  - The room starts in an open state.

### Story 2 — Join via invite link
As a user, I want to join a room via an invite link, so I can participate without the host manually adding me.

- Acceptance criteria:
  - Opening the link while logged in adds the user as a participant, up to the room's participant cap.
  - Opening the link while logged out routes through the LeetCode sync flow first, then completes the join automatically.

### Story 3 — Participant list
As a host, I want to see who's currently in my room, so I know who's present.

- Acceptance criteria:
  - The room view lists current participants, live-updating as people join/leave.

### Story 4 — Remove a participant
As a host, I want to remove a participant from my room, so I can moderate if needed.

- Acceptance criteria:
  - Removing a participant revokes their access to the room's live state (chat, active session) immediately.

### Story 5 — Close a room
As a host, I want to close the room when the hangout is over, so it stops accepting new joins/sessions and gets archived.

- Acceptance criteria:
  - A closed room's invite link stops admitting new participants.
  - No new sessions can be started in a closed room.
  - The room's history (past sessions and their final leaderboards) remains viewable to former participants after closure.

### Story 6 — Session history within a room
As a participant, I want to see a history of past sessions run in this room, so I can review results from earlier rounds.

- Acceptance criteria:
  - A list of past sessions (with their final standings) is visible from within the room, both while open and after archival.

### Story 7 — Capacity limits
As the system, I want a cap on participants per room, so a link-based join model can't be used to overload a single room.

- Acceptance criteria:
  - Joins beyond the configured participant cap are rejected with a clear message. (Cross-referenced in the Security epic alongside per-host room-count limits.)
