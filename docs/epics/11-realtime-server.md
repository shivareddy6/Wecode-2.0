# Epic 11 — Realtime Server (Socket.io)

**Goal:** A standalone socket.io service that carries all real-time traffic — chat messages and live leaderboard updates alike — authenticated against Supabase sessions and authorizing room access in application code. Deployed independently from the Next.js app. See `ARCHITECTURE.md` for the full reasoning behind choosing this over Supabase Realtime.

**Why it matters:** Chat (Epic 07) and the live leaderboard (Epic 06) both depend on this existing and being trustworthy — it's the one place both features' real-time delivery goes through.

**Status:** All 6 stories done. Stories 1–4 and 6 were built as `apps/socket-server`, a standalone npm workspace alongside `apps/web`, verified end-to-end via `apps/socket-server/scripts/verify.ts`. Story 5 (client reconnection) was picked up for real 2026-09-25, once real consumers existed (`LiveLeaderboard`/`ParticipantList`/`Chat`). See `apps/socket-server/README.md` for what's there and how to run it.

---

### Story 1 — Standalone service ✅
As the system, I want socket.io running as its own Node process, separate from the Next.js app, so persistent WebSocket connections aren't subject to serverless/Vercel connection timeouts.

- Acceptance criteria:
  - The socket.io server is its own deployable unit, independent of the Next.js build.
  - It deploys to a host built for persistent processes (Fly.io or Railway), not Vercel.

Built as `apps/socket-server`, its own npm workspace with its own `package.json`/`Dockerfile`, decoupled from `apps/web`'s build (including its own copy of `database.types.ts` rather than a cross-package import). Actually deploying to Fly.io/Railway is Epic 09 Story 5, out of scope here — this just needed to be deploy-ready.

### Story 2 — Authenticate connections against Supabase sessions ✅
As a user, I want my client to authenticate its socket connection using my existing WeCode session, so I don't need a separate login for real-time features.

- Acceptance criteria:
  - The client sends its Supabase-issued JWT as part of the connection handshake.
  - The server verifies the JWT locally (no round trip to Supabase's Auth server needed per connection).
  - A connection with a missing, invalid, or expired token is rejected before it can join any room's channel.

Implementation note: this project's Supabase Auth is still on the legacy HS256 shared-secret signing scheme — its JWKS endpoint returns an empty key set, not the asymmetric signing keys this story's wording originally assumed. Verification is done locally with `jose` against `SUPABASE_JWT_SECRET` (the dashboard's "Legacy JWT Secret"), same trust tier as `SUPABASE_SERVICE_ROLE_KEY`. If the project is ever migrated to asymmetric signing keys, this becomes a JWKS fetch+cache instead — same "reject before any room join" contract either way.

### Story 3 — Authorize room access explicitly ✅
As the system, I want a room-membership check before admitting a socket to that room's channel, so authorization isn't silently skipped now that Postgres RLS doesn't cover this path.

- Acceptance criteria:
  - Joining a room's channel requires a server-side membership check, equivalent in spirit to the DAL's `verifyRoomAccess(roomId)` (Epic 01, Story 7).
  - A participant removed/kicked from a room (Epic 04, Story 4) has their existing socket connection force-disconnected from that room's channel, not just blocked from future joins.

`room:join` calls the same `is_room_member`/`is_room_host` RPCs `verifyRoomAccess` uses, through a Supabase client that forwards the handshake JWT as its `Authorization` header (so `auth.uid()` resolves inside those `security definer` functions). The force-disconnect mechanism exists as `POST /internal/disconnect` (emits `room:kicked`, then removes the socket from the channel) — nothing calls it yet, since Epic 04 Story 4's kick action doesn't exist.

### Story 4 — Coordinated write-then-broadcast ✅
As the system, I want a chat message or leaderboard score change to be persisted to Postgres and broadcast to the room's connected sockets as one coordinated step, so the live view and the stored data don't drift apart.

- Acceptance criteria:
  - The same code path that performs the Postgres write is what triggers the corresponding broadcast — not a separate polling loop or an independent trigger mechanism.
  - A broadcast failure doesn't corrupt or roll back the persisted write.
  - A client that missed a broadcast (e.g. briefly disconnected) still sees correct data on its next full fetch, rather than depending on having received every individual event.

The mechanism is `POST /internal/broadcast {roomId, event, payload}`, gated on `REALTIME_INTERNAL_SECRET` so only `apps/web`'s own server can call it, never a browser. It's a pure "emit to the room's channel" call with no write of its own, so a broadcast failure can't touch the Postgres write that preceded it. Nothing calls it yet — Epic 06 Story 2 (leaderboard push) and Epic 07 (chat) are the intended callers.

### Story 5 — Graceful reconnection ✅
As a user, I want my client to reconnect automatically and recover current state if the socket server restarts or redeploys, so a deploy doesn't visibly break an in-progress session.

- Acceptance criteria:
  - Client-side automatic reconnection (socket.io's built-in support) is enabled.
  - On reconnect, the client re-fetches current room/session state rather than assuming its last-known in-memory state is still accurate.

**Status: Done**, picked up for real 2026-09-25 now that three real clients exist (`LiveLeaderboard`, `ParticipantList`, `Chat` — `apps/web/components/`). The first AC needed no code: socket.io-client's automatic reconnection is on by default and was already relied on implicitly (all three components already re-emit `room:join` on every `"connect"`, including reconnects, so a dropped socket doesn't just sit in no channel once it reconnects on its own).

The second AC was the actual gap: a component that reconnects after missing a push (e.g. the socket server briefly restarting) had no way to recover — it would just sit on stale state until the next unrelated write happened to trigger a fresh broadcast. Fixed identically in all three: a `hasConnectedBefore` ref, reset at the start of each mount's effect, distinguishes the very first `"connect"` (already covered by the page's SSR'd initial props) from every subsequent one (a real reconnect) — only the latter triggers a direct re-fetch of current state via the browser Supabase client (`compute_leaderboard` for the leaderboard, a `room_participants` query for the roster, the same `chat_messages` query/limit as the room page's initial fetch for chat).

Verified via `npm run verify:reconnect-refetch -w web` (3/3) — a script that can't literally mount the React components (no browser/login harness in this environment) but reimplements the identical connect-handler shape with a real `socket.io-client` against the real socket server: mutates Postgres directly without going through `broadcastToRoom` (simulating a push that gets missed entirely), forces a real abrupt disconnect via `engine.close()` (a clean `socket.disconnect()` call wouldn't auto-retry), and confirms the reconnect's refetch picks up the missed mutation. The underlying queries themselves were already proven correct by the existing `verify-participant-list`/`verify-chat`/`verify-leaderboard-push` scripts — this one specifically proves the *reconnect-vs-initial-connect* wiring recovers state a push-only model would have silently missed.

### Story 6 — Abuse protection on the socket server ✅
As the system, I want basic rate limiting and connection caps on the socket server itself, so a publicly reachable, always-on WebSocket endpoint isn't an easy target for connection or message floods.

- Acceptance criteria:
  - Per-connection rate limits apply to message emission (chat sends, etc.).
  - Connection caps per room/IP are consistent with the room/participant caps already defined in Epic 08.

Per-IP connection-attempt rate limiting and a generic per-socket event-emission rate limiter (currently wrapping `room:join`, ready to wrap chat sends unchanged) are both in place as in-memory token buckets. Room connection caps scale with that room's own `participant_cap` rather than a flat constant: total sockets in a room are capped at `participant_cap × MAX_SOCKETS_PER_USER_PER_ROOM`, with a separate per-(user, room) cap bounding one user's own share — deliberately not a 1:1 mapping, since one participant legitimately holds multiple sockets across tabs/devices.
