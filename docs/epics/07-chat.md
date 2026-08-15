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
