# Epic 11 — Realtime Server (Socket.io)

**Goal:** A standalone socket.io service that carries all real-time traffic — chat messages and live leaderboard updates alike — authenticated against Supabase sessions and authorizing room access in application code. Deployed independently from the Next.js app. See `ARCHITECTURE.md` for the full reasoning behind choosing this over Supabase Realtime.

**Why it matters:** Chat (Epic 07) and the live leaderboard (Epic 06) both depend on this existing and being trustworthy — it's the one place both features' real-time delivery goes through.

---

### Story 1 — Standalone service
As the system, I want socket.io running as its own Node process, separate from the Next.js app, so persistent WebSocket connections aren't subject to serverless/Vercel connection timeouts.

- Acceptance criteria:
  - The socket.io server is its own deployable unit, independent of the Next.js build.
  - It deploys to a host built for persistent processes (Fly.io or Railway), not Vercel.

### Story 2 — Authenticate connections against Supabase sessions
As a user, I want my client to authenticate its socket connection using my existing WeCode session, so I don't need a separate login for real-time features.

- Acceptance criteria:
  - The client sends its Supabase-issued JWT as part of the connection handshake.
  - The server verifies the JWT against Supabase's JWKS locally (no round trip to Supabase's Auth server needed per connection).
  - A connection with a missing, invalid, or expired token is rejected before it can join any room's channel.

### Story 3 — Authorize room access explicitly
As the system, I want a room-membership check before admitting a socket to that room's channel, so authorization isn't silently skipped now that Postgres RLS doesn't cover this path.

- Acceptance criteria:
  - Joining a room's channel requires a server-side membership check, equivalent in spirit to the DAL's `verifyRoomAccess(roomId)` (Epic 01, Story 7).
  - A participant removed/kicked from a room (Epic 04, Story 4) has their existing socket connection force-disconnected from that room's channel, not just blocked from future joins.

### Story 4 — Coordinated write-then-broadcast
As the system, I want a chat message or leaderboard score change to be persisted to Postgres and broadcast to the room's connected sockets as one coordinated step, so the live view and the stored data don't drift apart.

- Acceptance criteria:
  - The same code path that performs the Postgres write is what triggers the corresponding broadcast — not a separate polling loop or an independent trigger mechanism.
  - A broadcast failure doesn't corrupt or roll back the persisted write.
  - A client that missed a broadcast (e.g. briefly disconnected) still sees correct data on its next full fetch, rather than depending on having received every individual event.

### Story 5 — Graceful reconnection
As a user, I want my client to reconnect automatically and recover current state if the socket server restarts or redeploys, so a deploy doesn't visibly break an in-progress session.

- Acceptance criteria:
  - Client-side automatic reconnection (socket.io's built-in support) is enabled.
  - On reconnect, the client re-fetches current room/session state rather than assuming its last-known in-memory state is still accurate.

### Story 6 — Abuse protection on the socket server
As the system, I want basic rate limiting and connection caps on the socket server itself, so a publicly reachable, always-on WebSocket endpoint isn't an easy target for connection or message floods.

- Acceptance criteria:
  - Per-connection rate limits apply to message emission (chat sends, etc.).
  - Connection caps per room/IP are consistent with the room/participant caps already defined in Epic 08.
