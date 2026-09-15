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
