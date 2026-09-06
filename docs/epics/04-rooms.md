# Epic 04 — Rooms

**Goal:** A room is the container for one hangout with friends — created, joined via a link, and eventually closed. Rooms are ephemeral: they don't persist as standing groups across unrelated future hangouts (see `PRD.md` for the reasoning).

---

### Story 1 — Create a room
As a user, I want to create a room, so I have a place to invite friends into.

- Acceptance criteria:
  - Creating a room generates a unique invite link/code.
  - The creator becomes the room's host.
  - The room starts in an open state.

**Status: Done.** `createRoom` (`app/rooms/actions.ts`), addressed by its `invite_code` everywhere in the URL, not the raw UUID (`resolveRoomIdByCode`, `lib/dal.ts`).

### Story 2 — Join via invite link
As a user, I want to join a room via an invite link, so I can participate without the host manually adding me.

- Acceptance criteria:
  - Opening the link while logged in adds the user as a participant, up to the room's participant cap.
  - Opening the link while logged out routes through the LeetCode sync flow first, then completes the join automatically.

**Status: Done.** `joinRoom` (`app/rooms/actions.ts`), called automatically from `app/rooms/[code]/page.tsx`'s render — no separate "click join" step. Logged-out visitors see the landing page's `LeetCodeSyncForm` reused on the room page; `proxy.ts` opens `/rooms/[code]` itself (only that exact segment, not nested routes) to signed-out traffic so they can actually reach it.

Race condition found in code review and fixed: the original implementation read the active-participant count, then inserted as a separate app-layer round trip — two concurrent joins near the cap could both read "under cap" and both insert, overfilling the room past `participant_cap`. Fixed by moving the whole host/membership/status/cap check-and-insert into one atomic `join_room()` SQL function (migration `20260906110000_join_room_atomic.sql`) that locks the room row (`SELECT ... FOR UPDATE`) before checking or inserting anything, so concurrent callers serialize on that lock instead of racing. `joinRoom` is now a thin RPC wrapper. Verified against real data: room-not-found, host no-op, full-room rejection, and closed-room rejection all behave correctly; the "already a member" no-op and the actual successful insert still need a second real `users` row to test with a caller distinct from the host (the FK on `room_participants.user_id` blocks faking one) — worth watching once a second real account joins a room for the first time.

### Story 3 — Participant list
As a host, I want to see who's currently in my room, so I know who's present.

- Acceptance criteria:
  - The room view lists current participants, live-updating as people join/leave.

**Status: Not started.**

### Story 4 — Remove a participant
As a host, I want to remove a participant from my room, so I can moderate if needed.

- Acceptance criteria:
  - Removing a participant revokes their access to the room's live state (chat, active session) immediately.

**Status: Not started.** The "immediately" in the AC really wants Epic 11's live sockets to force-disconnect an existing connection, not just block future page loads — worth sequencing after Epic 11 exists rather than half-delivering this now.

### Story 5 — Close a room
As a host, I want to close the room when the hangout is over, so it stops accepting new joins/sessions and gets archived.

- Acceptance criteria:
  - A closed room's invite link stops admitting new participants.
  - No new sessions can be started in a closed room.
  - The room's history (past sessions and their final leaderboards) remains viewable to former participants after closure.

**Status: Not started.** Note: the third AC (viewable history after closure) conflicts with the user's own explicit call that session/round history browsing is out of scope (see Story 6) — when this gets picked up, that AC needs revisiting, not literal implementation.

### Story 6 — Session history within a room
As a participant, I want to see a history of past sessions run in this room, so I can review results from earlier rounds.

- Acceptance criteria:
  - A list of past sessions (with their final standings) is visible from within the room, both while open and after archival.

**Status: Out of scope**, by the user's own explicit call — see `docs/SCHEMA.md`'s "Room-centric rounds" section. The schema deliberately doesn't retain the history this story would need; building it would mean reversing that design decision, not just adding UI.

### Story 7 — Capacity limits
As the system, I want a cap on participants per room, so a link-based join model can't be used to overload a single room.

- Acceptance criteria:
  - Joins beyond the configured participant cap are rejected with a clear message. (Cross-referenced in the Security epic alongside per-host room-count limits.)

**Status: Done**, as a side effect of Story 2's join flow — `joinRoom` (`app/rooms/actions.ts`) checks `rooms.participant_cap` against the live active-participant count before inserting, and throws a clear "This room is full." error. Per-host room-count limits (the Security-epic cross-reference) remain unaddressed.
