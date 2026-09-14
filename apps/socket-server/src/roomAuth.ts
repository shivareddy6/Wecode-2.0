import type { UserClient } from "./supabaseUser.js";

export type RoomAccess = {
  isMember: boolean;
  isHost: boolean;
};

// Mirrors apps/web/lib/dal.ts's verifyRoomAccess — same two RPCs, same
// "member or host" rule — just called with a JWT forwarded over a socket
// handshake instead of a cookie-based session. This is the one place a
// socket gets admitted to a room's channel; RLS doesn't cover this path
// at all since this server talks to Postgres directly, not through a
// browser-held Supabase session (ARCHITECTURE.md's DAL section).
export async function checkRoomAccess(
  client: UserClient,
  roomId: string,
): Promise<RoomAccess> {
  const [memberResult, hostResult] = await Promise.all([
    client.rpc("is_room_member", { p_room_id: roomId }),
    client.rpc("is_room_host", { p_room_id: roomId }),
  ]);

  if (memberResult.error || hostResult.error) {
    throw new Error(
      memberResult.error?.message ?? hostResult.error?.message ?? "RPC failed",
    );
  }

  return {
    isMember: Boolean(memberResult.data),
    isHost: Boolean(hostResult.data),
  };
}

// rooms' own RLS select policy already grants read access to members/host
// (SCHEMA.md), so this is a plain select through the same user-scoped
// client — no new RPC needed.
export async function getParticipantCap(
  client: UserClient,
  roomId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from("rooms")
    .select("participant_cap")
    .eq("id", roomId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.participant_cap;
}
