import "server-only";

// Epic 06, Story 2 / Epic 11, Story 4 — the "coordinated write-then-
// broadcast" half: whatever server code just wrote the thing this event
// describes calls this right after, on the same code path, so the
// persisted write and the live push can't drift apart. REALTIME_SERVER_URL
// and REALTIME_INTERNAL_SECRET are server-only env vars (no NEXT_PUBLIC_
// prefix) — this must never be reachable from the browser, only from
// apps/web's own server. Failures are swallowed (logged, not thrown): a
// missed live push just means participants see the update on their next
// natural refresh instead of instantly, not a broken submission.
export async function broadcastToRoom(
  roomId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const url = process.env.REALTIME_SERVER_URL;
  const secret = process.env.REALTIME_INTERNAL_SECRET;

  if (!url || !secret) {
    console.error("broadcastToRoom: REALTIME_SERVER_URL/REALTIME_INTERNAL_SECRET not configured");
    return;
  }

  try {
    const response = await fetch(`${url}/internal/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ roomId, event, payload }),
    });

    if (!response.ok) {
      console.error(`broadcastToRoom: realtime server responded ${response.status}`);
    }
  } catch (error) {
    console.error("broadcastToRoom: failed to reach realtime server", error);
  }
}

// Epic 04, Story 4 — the live half of a kick: the DB write
// (room_participants.removed_at) already blocks the removed user from
// anything they'd load or join going forward, via RLS's is_room_member;
// this forces any *already-open* socket (e.g. a leaderboard tab) to leave
// the room channel right away, instead of waiting for that tab's next
// natural reconnect/refresh to notice. Same "failures are swallowed"
// posture as broadcastToRoom — a missed disconnect just means that one
// open tab keeps receiving pushes until it naturally reconnects, not a
// broken removal (the DB write, which is the part that actually revokes
// access, already succeeded by the time this runs).
export async function disconnectUserFromRoom(roomId: string, userId: string): Promise<void> {
  const url = process.env.REALTIME_SERVER_URL;
  const secret = process.env.REALTIME_INTERNAL_SECRET;

  if (!url || !secret) {
    console.error("disconnectUserFromRoom: REALTIME_SERVER_URL/REALTIME_INTERNAL_SECRET not configured");
    return;
  }

  try {
    const response = await fetch(`${url}/internal/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({ roomId, userId }),
    });

    if (!response.ok) {
      console.error(`disconnectUserFromRoom: realtime server responded ${response.status}`);
    }
  } catch (error) {
    console.error("disconnectUserFromRoom: failed to reach realtime server", error);
  }
}
