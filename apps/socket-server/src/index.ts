import { createServer } from "node:http";
import { Server } from "socket.io";
import { env } from "./env.js";
import { verifyAccessToken } from "./jwt.js";
import { buildUserClient } from "./supabaseUser.js";
import { checkRoomAccess, getParticipantCap } from "./roomAuth.js";
import {
  allowConnectionAttempt,
  MAX_SOCKETS_PER_USER_PER_ROOM,
  releaseRoomSlot,
  stopConnectionLimitSweep,
  tryReserveRoomSlot,
} from "./connectionLimits.js";
import { rateLimited, clearEventRateLimit } from "./eventRateLimit.js";
import { roomChannel } from "./roomChannel.js";
import { handleInternalRequest } from "./internalApi.js";

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: { origin: env.allowedOrigin },
});

// socket.io's own request listener (attached inside `new Server(...)`)
// is a separate listener on this same "request" event — Node invokes
// every listener for every request, there's no first-match-wins here.
// It only *responds* to its own path prefix (default `/socket.io/`), but
// it still fires this listener for those requests too, so we have to
// explicitly ignore that prefix ourselves rather than assuming socket.io
// having handled it stops us from also writing a (conflicting) response.
httpServer.on("request", (req, res) => {
  if (req.url?.startsWith("/socket.io/")) {
    return;
  }

  // handleInternalRequest already catches its own body-parsing errors;
  // this .catch() is a second line of defense against anything else
  // unexpectedly throwing in there, so a bug in this path degrades to one
  // failed request instead of an unhandled rejection crashing the process.
  void handleInternalRequest(req, res, io)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    })
    .catch((error) => {
      console.error("Unexpected error handling internal request:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
});

// Story 6: per-IP connect-attempt cap, checked before doing any JWT work.
io.use((socket, next) => {
  const ip = socket.handshake.address;
  if (!allowConnectionAttempt(ip)) {
    next(new Error("rate_limited"));
    return;
  }
  next();
});

// Story 2: reject a connection with a missing/invalid/expired token
// before it can join any room's channel.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || !token) {
    next(new Error("unauthorized"));
    return;
  }

  try {
    const { userId } = await verifyAccessToken(token);
    socket.data.userId = userId;
    socket.data.accessToken = token;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

type JoinAck = (response: { ok: boolean; reason?: string }) => void;

io.on("connection", (socket) => {
  socket.on(
    "room:join",
    rateLimited(socket, async (payload: { roomId?: string }, ack?: JoinAck) => {
      const respond: JoinAck = typeof ack === "function" ? ack : () => {};
      const roomId = payload?.roomId;

      if (typeof roomId !== "string" || !roomId) {
        respond({ ok: false, reason: "invalid_room" });
        return;
      }

      const userId = socket.data.userId as string;
      const accessToken = socket.data.accessToken as string;
      const client = buildUserClient(accessToken);

      // Story 3: room-membership check before admitting a socket to that
      // room's channel — the app-code equivalent of
      // apps/web/lib/dal.ts's verifyRoomAccess, since RLS doesn't cover
      // this path (this server talks to Postgres directly, not through
      // a browser-held Supabase session).
      let access;
      let participantCap;
      try {
        [access, participantCap] = await Promise.all([
          checkRoomAccess(client, roomId),
          getParticipantCap(client, roomId),
        ]);
      } catch {
        respond({ ok: false, reason: "lookup_failed" });
        return;
      }

      if (!access.isMember && !access.isHost) {
        respond({ ok: false, reason: "not_a_member" });
        return;
      }

      if (participantCap === null) {
        respond({ ok: false, reason: "lookup_failed" });
        return;
      }

      // Story 6: total concurrent sockets in a room scale with that
      // room's own participant_cap (Epic 08) rather than a single global
      // constant, and MAX_SOCKETS_PER_USER_PER_ROOM bounds one user's
      // share of that — see connectionLimits.ts for why this isn't a
      // literal 1:1 cap-to-connections mapping.
      const channel = roomChannel(roomId);
      const currentSocketsInRoom = io.sockets.adapter.rooms.get(channel)?.size ?? 0;
      if (currentSocketsInRoom >= participantCap * MAX_SOCKETS_PER_USER_PER_ROOM) {
        respond({ ok: false, reason: "room_at_capacity" });
        return;
      }

      if (!tryReserveRoomSlot(userId, roomId, socket.id)) {
        respond({ ok: false, reason: "too_many_connections" });
        return;
      }

      socket.data.roomId = roomId;
      socket.join(channel);
      respond({ ok: true });
    }),
  );

  socket.on("disconnect", () => {
    clearEventRateLimit(socket);
    const userId = socket.data.userId as string | undefined;
    const roomId = socket.data.roomId as string | undefined;
    if (userId && roomId) {
      releaseRoomSlot(userId, roomId, socket.id);
    }
  });
});

httpServer.listen(env.port, () => {
  console.log(`socket-server listening on :${env.port}`);
});

// A deploy (Fly.io/Railway, Epic 09 Story 5) sends SIGTERM on rolling
// restart; without a handler, Node's default is to terminate immediately,
// dropping in-flight HTTP requests and socket messages rather than
// letting them finish. io.close() disconnects clients and stops the
// engine.io server, but — per socket.io's docs — does not close an
// httpServer it didn't create itself, so that's closed explicitly after.
// The forced exit below is a backstop in case either close() call hangs
// (e.g. a client that never acknowledges the disconnect).
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} received, shutting down gracefully`);
  stopConnectionLimitSweep();

  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  io.close(() => {
    httpServer.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
