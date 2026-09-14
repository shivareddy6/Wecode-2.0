# WeCode realtime server

Standalone socket.io service (Epic 11) carrying real-time traffic — chat and the live leaderboard alike — for the WeCode Next.js app (`apps/web`). Deployed independently, since Vercel's serverless model can't hold a persistent WebSocket connection. See `docs/epics/11-realtime-server.md` and `docs/ARCHITECTURE.md`'s "Data & Real-time" section for the full reasoning.

## What's here

- Connection auth: a client presents its Supabase-issued access token in the socket handshake (`auth: { token }`); verified locally (HS256 against the project's legacy JWT secret — see `.env.example`'s `SUPABASE_JWT_SECRET` comment for why it's HS256 and not the newer JWKS scheme).
- Room authorization: joining a room's channel (`socket.emit('room:join', { roomId }, ack)`) requires an `is_room_member`/`is_room_host` check via a Supabase client scoped to that user's forwarded token — the same RPCs `apps/web/lib/dal.ts`'s `verifyRoomAccess` uses, just called with a handshake token instead of a cookie.
- Internal API (`/internal/broadcast`, `/internal/disconnect`), gated on `REALTIME_INTERNAL_SECRET` — only `apps/web`'s own server should call these, never a browser. Nothing calls them yet this session; they're the mechanism Epic 06 Story 2 (leaderboard push), Epic 07 (chat), and Epic 04 Story 4 (kick) will call into.
- Connection caps (per-IP connect attempts, per-user-per-room concurrent sockets, total room sockets scaled to the room's `participant_cap`) and a generic per-socket event rate limiter.

Not here yet: client-side reconnection handling (Epic 11 Story 5) — deliberately deferred until a real consumer exists, see the epic file.

## Local development

```
npm install          # from the repo root — this is an npm workspace
cp apps/socket-server/.env.example apps/socket-server/.env
# fill in SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_JWT_SECRET,
# REALTIME_INTERNAL_SECRET, SUPABASE_SERVICE_ROLE_KEY (the last one only
# needed for `npm run verify`)
npm run dev -w socket-server
```

Health check: `GET http://localhost:4001/healthz`.

## Verifying it works

No UI consumes this yet, so `npm run verify -w socket-server` (`scripts/verify.ts`) is the test: it creates its own throwaway Supabase user + room via the service-role key, exercises connection auth, room authorization, the internal broadcast/disconnect endpoints, and connection caps against a running `npm run dev -w socket-server` instance, then deletes everything it created. Run the dev server in one terminal and the verify script in another.

## Deploying (not done yet — Epic 09 Story 5)

`Dockerfile` builds a production image; point Fly.io or Railway at this directory as the build context. Needs the same env vars as `.env.example` (minus `SUPABASE_SERVICE_ROLE_KEY`, which is only for the verify script) configured on the host. `apps/web`'s deploy will need a `REALTIME_SERVER_URL` env var pointing at wherever this ends up — not added yet since nothing in `apps/web` calls this service yet.
