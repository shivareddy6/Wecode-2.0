# Epic 07 — Chat

**Goal:** Real-time, room-scoped text chat — the social glue that makes a session feel like hanging out rather than four people silently solving in parallel.

---

### Story 1 — Send and receive messages
As a participant, I want to send and receive text messages with everyone currently in the room, so we can talk while solving.

- Acceptance criteria:
  - Messages delivered via the socket.io server (Epic 11) to all current room participants.
  - Messages persist for the life of the room and are visible as history to participants who join later.

### Story 2 — Sender identity
As a participant, I want to see who sent each message, so conversations are easy to follow.

- Acceptance criteria:
  - Each message displays the sender's name and avatar, sourced from their LeetCode profile.

### Story 3 — Basic moderation
As a host, I want to delete a message or remove a participant from chat, so the room stays usable in a group of friends.

- Acceptance criteria:
  - A host can delete any message in their room.
  - Removing a participant from the room (Epic 04, Story 4) also removes their chat access.

### Story 4 — Input limits
As the system, I want basic sanitization and a length limit on chat messages, so the app isn't trivially abusable for spam or injection.

- Acceptance criteria:
  - Messages are sanitized before storage/render (no raw HTML execution).
  - Messages beyond a reasonable length are rejected client- and server-side.

### Story 5 — Submission activity in chat
As a participant, I want to see when someone in the room submits a problem, so the room feels alive without everyone having to announce it themselves.

- Acceptance criteria:
  - A system-style chat entry appears when a participant's submission is judged, naming the participant, the problem, and the verdict.
  - A submission flagged `is_out_of_contest` (Epic 05, Story 5 — made after the round's deadline) is visibly marked as out-of-contest in that chat entry, distinct from an in-contest one, so it's never mistaken for a scoring submission.

**Status: Not started** (added 2026-09-06, when the out-of-contest requirement was raised — this story didn't exist before then). Depends on this epic existing at all (nothing here is built yet) and on Epic 11 for delivery. The data it needs already exists: `submissions.is_out_of_contest` (see `docs/SCHEMA.md`), set at insert time in `app/api/submissions/route.ts`.
