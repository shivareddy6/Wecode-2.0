# Epic 04 — Rooms

**Goal:** A room is the container for one hangout with friends — created, joined via a link, and eventually closed. Rooms are ephemeral: they don't persist as standing groups across unrelated future hangouts (see `PRD.md` for the reasoning).

---

### Story 1 — Create a room
As a user, I want to create a room, so I have a place to invite friends into.

- Acceptance criteria:
  - Creating a room generates a unique invite link/code.
  - The creator becomes the room's host.
  - The room starts in an open state.

**Status: Done.** `createRoom` (`app/rooms/actions.ts`) calls `create_room()` (`supabase/migrations/20260906130000_host_is_a_participant.sql`), which atomically inserts the room *and* the creator's own `room_participants` row in one transaction — the host is a real participant from the moment the room exists, not tracked purely via `host_user_id` (see `docs/SCHEMA.md`'s "Room membership: the host is a participant too", decided after review while designing Epic 06's leaderboard). Addressed by its `invite_code` everywhere in the URL, not the raw UUID (`resolveRoomIdByCode`, `lib/dal.ts`).

### Story 2 — Join via invite link
As a user, I want to join a room via an invite link, so I can participate without the host manually adding me.

- Acceptance criteria:
  - Opening the link while logged in adds the user as a participant, up to the room's participant cap.
  - Opening the link while logged out routes through the LeetCode sync flow first, then completes the join automatically.

**Status: Done.** `joinRoom` (`app/rooms/actions.ts`), called automatically from `app/rooms/[code]/page.tsx`'s render — no separate "click join" step. Logged-out visitors see the landing page's `LeetCodeSyncForm` reused on the room page; `proxy.ts` opens `/rooms/[code]` itself (only that exact segment, not nested routes) to signed-out traffic so they can actually reach it. `join_room()` no longer special-cases the host with an early return (`20260906130000_host_is_a_participant.sql`) — since `create_room()` now gives the host a `room_participants` row up front, the ordinary "already a member" no-op check covers them identically to anyone else. As a consequence, the host now counts against `participant_cap` too, per the same review — the cap bounds total people in the room, not "non-host people."

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

One invariant is already enforced ahead of this story being built: since the host now holds a real, updatable `room_participants` row (see Story 1/2 above), the `"hosts can remove participants"` RLS policy's `using` clause (`20260906130000_host_is_a_participant.sql`) excludes any row whose `user_id` matches the room's current `host_user_id` — a host can never remove themself through this path, by construction, not by an app-layer check this story would otherwise need to remember to add.

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

### Story 8 — Transfer host (good-to-have, spike)
As a host, I want to hand off host powers to another participant, so someone else can run the room if I need to step away.

- Not committed scope — flagged here so the idea isn't lost, not queued for a sprint. Also fills a real gap noted in earlier handoff notes: today there's no way to leave hosting behind at all (`is_room_host` is permanently pinned to `rooms.host_user_id`), so a host who disappears leaves the room stuck — no new round, no close.
- Proposed shape, cheap specifically because of the Epic 04/06 design decision that the host holds a real `room_participants` row (see Story 1, `docs/SCHEMA.md`'s "Room membership: the host is a participant too"): transfer is a single `UPDATE rooms SET host_user_id = <new_user_id>`, restricted to an existing participant (`is_room_member`) of the same room. The outgoing host's own `room_participants` row is untouched by the transfer — they keep their leaderboard standing and chat presence automatically, nothing to re-create.
- Open questions to resolve if this gets picked up, not answered by the spike framing: can the host transfer to themselves-effectively-leaving (i.e. is "host leaves entirely" a separate flow from "host hands off"), what happens to an in-progress round mid-transfer, and whether the new host needs to explicitly accept vs. the current host just designating them.

**Status: Not started — spike/nice-to-have**, not a committed story.
