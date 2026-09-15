import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "socket.io";
import { env } from "./env.js";
import { getSocketIdsForUserInRoom } from "./connectionLimits.js";
import { roomChannel } from "./roomChannel.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Trusted server-to-server API — only apps/web's own server (never a
// browser) should ever call these, gated on a shared secret rather than
// a user session. This is the "coordinated write-then-broadcast" half of
// Epic 11 Story 4: whatever Next.js server action performs a Postgres
// write calls /internal/broadcast right after, on the same code path, so
// the persisted write and the live push can't drift apart from each
// other. Nothing calls these yet this session (no chat, no leaderboard
// push wired up) — they're the mechanism Epic 06 Story 2 and Epic 07
// will call into, and Epic 04 Story 4 (kick) will call /internal/disconnect.
//
// Returns false if the request didn't match any route here, so the
// caller (index.ts) can 404 it.
export async function handleInternalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  io: Server,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://internal");

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, 200, { ok: true });
    return true;
  }

  if (!url.pathname.startsWith("/internal/")) {
    return false;
  }

  if (req.headers["x-internal-secret"] !== env.internalSecret) {
    send(res, 401, { error: "unauthorized" });
    return true;
  }

  // readJsonBody's JSON.parse throws on a malformed body — caught here
  // rather than left to propagate, since the caller (index.ts) only
  // .then()s this promise with no .catch(): an uncaught rejection here
  // would otherwise be an unhandled rejection that crashes the whole
  // process (Node's default since v15), taking down every room's chat
  // and leaderboard, not just this one bad request.
  try {
    if (req.method === "POST" && url.pathname === "/internal/broadcast") {
      const body = await readJsonBody(req);
      const roomId = body.roomId;
      const event = body.event;

      if (typeof roomId !== "string" || typeof event !== "string") {
        send(res, 400, { error: "roomId and event are required" });
        return true;
      }

      io.to(roomChannel(roomId)).emit(event, body.payload);
      send(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/internal/disconnect") {
      const body = await readJsonBody(req);
      const roomId = body.roomId;
      const userId = body.userId;

      if (typeof roomId !== "string" || typeof userId !== "string") {
        send(res, 400, { error: "roomId and userId are required" });
        return true;
      }

      const socketIds = getSocketIdsForUserInRoom(userId, roomId);
      for (const socketId of socketIds) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.emit("room:kicked", { roomId });
        socket.leave(roomChannel(roomId));
      }

      send(res, 200, { ok: true, disconnected: socketIds.size });
      return true;
    }
  } catch {
    send(res, 400, { error: "malformed request body" });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}
