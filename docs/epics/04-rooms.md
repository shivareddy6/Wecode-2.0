# Epic 04 — Rooms

**Goal:** A room is the container for one hangout with friends — created, joined via a link, and eventually closed. Rooms are ephemeral: they don't persist as standing groups across unrelated future hangouts (see `PRD.md` for the reasoning).

---

### Story 1 — Create a room
As a user, I want to create a room, so I have a place to invite friends into.

- Acceptance criteria:
  - Creating a room generates a unique invite link/code.
  - The creator becomes the room's host.
  - The room starts in an open state.

**Status: Done.** `createRoom` (`apps/web/app/rooms/actions.ts`) calls `create_room()` (`supabase/migrations/20260906130000_host_is_a_participant.sql`), which atomically inserts the room *and* the creator's own `room_participants` row in one transaction — the host is a real participant from the moment the room exists, not tracked purely via `host_user_id` (see `docs/SCHEMA.md`'s "Room membership: the host is a participant too", decided after review while designing Epic 06's leaderboard). Addressed by its `invite_code` everywhere in the URL, not the raw UUID (`resolveRoomIdByCode`, `apps/web/lib/dal.ts`).

### Story 2 — Join via invite link
As a user, I want to join a room via an invite link, so I can participate without the host manually adding me.

- Acceptance criteria:
  - Opening the link while logged in adds the user as a participant, up to the room's participant cap.
  - Opening the link while logged out routes through the LeetCode sync flow first, then completes the join automatically.

**Status: Done.** `joinRoom` (`apps/web/app/rooms/actions.ts`), called automatically from `apps/web/app/rooms/[code]/page.tsx`'s render — no separate "click join" step. Logged-out visitors see the landing page's `LeetCodeSyncForm` reused on the room page; `apps/web/proxy.ts` opens `/rooms/[code]` itself (only that exact segment, not nested routes) to signed-out traffic so they can actually reach it. `join_room()` no longer special-cases the host with an early return (`20260906130000_host_is_a_participant.sql`) — since `create_room()` now gives the host a `room_participants` row up front, the ordinary "already a member" no-op check covers them identically to anyone else. As a consequence, the host now counts against `participant_cap` too, per the same review — the cap bounds total people in the room, not "non-host people."

Race condition found in code review and fixed: the original implementation read the active-participant count, then inserted as a separate app-layer round trip — two concurrent joins near the cap could both read "under cap" and both insert, overfilling the room past `participant_cap`. Fixed by moving the whole host/membership/status/cap check-and-insert into one atomic `join_room()` SQL function (migration `20260906110000_join_room_atomic.sql`) that locks the room row (`SELECT ... FOR UPDATE`) before checking or inserting anything, so concurrent callers serialize on that lock instead of racing. `joinRoom` is now a thin RPC wrapper. Verified against real data: room-not-found, host no-op, full-room rejection, and closed-room rejection all behave correctly; the "already a member" no-op and the actual successful insert still need a second real `users` row to test with a caller distinct from the host (the FK on `room_participants.user_id` blocks faking one) — worth watching once a second real account joins a room for the first time.

### Story 3 — Participant list
As a host, I want to see who's currently in my room, so I know who's present.

- Acceptance criteria:
  - The room view lists current participants, live-updating as people join/leave.

**Status: Done.** The roster is now visible to every member, not just the host — `ParticipantList` (`apps/web/components/participant-list.tsx`) renders in `apps/web/app/rooms/[code]/page.tsx` for all members, same visibility model as the leaderboard, layered on top of the SSR'd initial roster the same way `LiveLeaderboard` (Epic 06, Story 2) layers over the leaderboard's initial rows: a socket.io connection replaces the whole row set on every pushed `"participants:update"`.

The broadcast is pushed from the two places that actually change the roster — `joinRoom` and `removeParticipant` (`apps/web/app/rooms/actions.ts`) — the same "write, then broadcast on the same request" shape Epic 06 Story 2 established for the leaderboard. One thing this needed that Story 4's `join_room()` didn't already provide: `joinRoom` is called on *every* room-page render (including the 5-second refresh poll during an active round), not just an actual first-time join, and broadcasting a fresh roster on every no-op call would spam every open socket with an unchanged payload. Fixed by having `join_room()` (`supabase/migrations/20260920100000_join_room_reports_insert.sql`) return `true` only when it actually inserted a row — `false` for the ordinary "already a member" no-op — so `joinRoom` only broadcasts when the roster really changed.

Verified end-to-end via `npm run verify:participant-list -w web` (6/6): `join_room()`'s true/false return value on a real join vs. a repeat no-op call, a real join's socket push landing with both members, and a kick's socket push landing with the kicked member gone.

### Story 4 — Remove a participant
As a host, I want to remove a participant from my room, so I can moderate if needed.

- Acceptance criteria:
  - Removing a participant revokes their access to the room's live state (chat, active session) immediately.

**Status: Done.** `removeParticipant` (`apps/web/app/rooms/actions.ts`) is a direct table update under RLS — the same shape as `endRound` — not a new RPC: the `"hosts can remove participants"` policy already restricts it to the host and already excludes the host's own row, so there's no host/self-target logic to duplicate in the action itself. Soft-delete only (`removed_at`, not a deleted row), per `docs/SCHEMA.md`'s "Removal is soft" note.

Two things this story had to resolve that weren't settled going in:

- **The "immediately" in the AC** — `disconnectUserFromRoom` (`apps/web/lib/realtime/broadcast.ts`) POSTs to Epic 11's `/internal/disconnect`, which emits `room:kicked` and drops the socket from the room channel right away. `LiveLeaderboard` (`apps/web/components/live-leaderboard.tsx`) — the only place in the app with an open room socket today — listens for it and redirects the removed user to `/`. Everything else (join attempts, RPCs, future page loads) is already blocked going forward the moment the DB write lands, since every room-scoped RLS policy runs through `is_room_member()`, which checks `removed_at is null`.
- **Rejoin after removal — product decision, resolved 2026-09-17:** kicked means kicked. `join_room()` (`supabase/migrations/20260917100000_kick_participant.sql`) now explicitly rejects a caller with a `removed_at` row for that room, before falling through to the "already a member"/insert path that would otherwise hit a duplicate-key error on the `(room_id, user_id)` primary key (nothing had ever set `removed_at` before this story, so that path was dead code until now).

One invariant was already enforced ahead of this story being built: since the host now holds a real, updatable `room_participants` row (see Story 1/2 above), the `"hosts can remove participants"` RLS policy's `using` clause (`20260906130000_host_is_a_participant.sql`) excludes any row whose `user_id` matches the room's current `host_user_id` — a host can never remove themself through this path, by construction, not by an app-layer check this story would otherwise need to remember to add.

The participant list this needed to be usable (a host has to pick *someone* to remove) is a minimal, host-only, non-live roster rendered directly in `apps/web/app/rooms/[code]/page.tsx` — not the full live-updating list Story 3 asks for. Verified end-to-end via `npm run verify:kick-participant -w web` (7/7): the DB write, the host-can't-remove-self RLS guard, the live socket disconnect, the rejoin block, and that a bystander is unaffected.

### Story 5 — Close a room
As a host, I want to close the room when the hangout is over, so it stops accepting new joins/sessions.

- Acceptance criteria:
  - A closed room's invite link stops admitting new participants.
  - No new sessions can be started in a closed room.
  - Nothing about the room (chat, leaderboard, past rounds) is required to remain viewable once it's closed — closing is a hard stop, not an archival step.

**Product decision, resolved 2026-09-17:** dropped the original "viewable history after closure" AC — it conflicted with the user's own explicit call that session/round history browsing is out of scope (Story 6), and is now explicitly superseded: closing a room doesn't need to preserve or expose anything about it afterward. This also resolves the same conflict noted on Epic 06, Story 4.

**Status: Done.** `closeRoom` (`apps/web/app/rooms/actions.ts`) is a direct table update under RLS — the same shape as `endRound`/`removeParticipant`, no new RPC — flipping `rooms.status` from `'open'` to `'closed'` and stamping `closed_at`. The `"hosts manage their own rooms"` RLS policy already restricts this update to the host, and the `.eq("status", "open")` filter makes a second close attempt a harmless no-op rather than re-stamping `closed_at`.

The two enforcement points the AC needs already existed on one side and were missing on the other: `join_room()` has rejected joins to a non-open room since Story 2, but `start_room_round()` never checked room status at all — a closed room's host could still start a brand new round. Fixed by adding that guard (`supabase/migrations/20260920110000_close_room.sql`), ahead of the existing host-only check. Deliberately untouched, per the AC's own "hard stop, not an archival step" line: existing read access to the room's current round/leaderboard/chat for people already in it — `is_room_member()`/`is_room_host()` only ever check `removed_at`, never `rooms.status`.

The room page hides the start-round/end-round/close-room controls once `room.status !== 'open'`, but existing members keep reading everything else about the room unchanged.

Verified end-to-end via `npm run verify:close-room -w web` (6/6): a non-host can't close the room, the host's close write lands and is idempotent, a new participant is rejected on join, `start_room_round` is rejected, and an existing member retains read access afterward.

### Story 6 — Session history within a room
As a participant, I want to see a history of past sessions run in this room, so I can review results from earlier rounds.

- Acceptance criteria:
  - A list of past sessions (with their final standings) is visible from within the room, both while open and after archival.

**Status: Out of scope**, by the user's own explicit call — see `docs/SCHEMA.md`'s "Room-centric rounds" section. The schema deliberately doesn't retain the history this story would need; building it would mean reversing that design decision, not just adding UI.

### Story 7 — Capacity limits
As the system, I want a cap on participants per room, so a link-based join model can't be used to overload a single room.

- Acceptance criteria:
  - Joins beyond the configured participant cap are rejected with a clear message. (Cross-referenced in the Security epic alongside per-host room-count limits.)

**Status: Done**, as a side effect of Story 2's join flow — `joinRoom` (`apps/web/app/rooms/actions.ts`) checks `rooms.participant_cap` against the live active-participant count before inserting, and throws a clear "This room is full." error. Per-host room-count limits (the Security-epic cross-reference) remain unaddressed.

### Story 8 — Transfer host (good-to-have, spike)
As a host, I want to hand off host powers to another participant, so someone else can run the room if I need to step away.

- Not committed scope — flagged here so the idea isn't lost, not queued for a sprint. Also fills a real gap noted in earlier handoff notes: today there's no way to leave hosting behind at all (`is_room_host` is permanently pinned to `rooms.host_user_id`), so a host who disappears leaves the room stuck — no new round, no close.
- Proposed shape, cheap specifically because of the Epic 04/06 design decision that the host holds a real `room_participants` row (see Story 1, `docs/SCHEMA.md`'s "Room membership: the host is a participant too"): transfer is a single `UPDATE rooms SET host_user_id = <new_user_id>`, restricted to an existing participant (`is_room_member`) of the same room. The outgoing host's own `room_participants` row is untouched by the transfer — they keep their leaderboard standing and chat presence automatically, nothing to re-create.
- Open questions to resolve if this gets picked up, not answered by the spike framing: can the host transfer to themselves-effectively-leaving (i.e. is "host leaves entirely" a separate flow from "host hands off"), what happens to an in-progress round mid-transfer, and whether the new host needs to explicitly accept vs. the current host just designating them.

**Status: Not started — spike/nice-to-have**, not a committed story.
