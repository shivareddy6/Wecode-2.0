"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import { removeParticipant } from "@/app/rooms/actions";

export type ParticipantRow = { user_id: string; display_name: string | null };

// Epic 04, Story 3 — live-updating roster for everyone in the room, not
// just the host-only static list Story 4 shipped with. Same socket
// pattern as LiveLeaderboard: connect, join the room channel on every
// "connect" (including auto-reconnects), replace the whole row set
// whenever the server pushes a fresh "participants:update" (from
// joinRoom/removeParticipant in app/rooms/actions.ts). The Remove button
// stays host-only and self-excluded, same as the Story 4 markup this
// replaces.
export function ParticipantList({
  roomId,
  initialParticipants,
  isHost,
  viewerId,
}: {
  roomId: string;
  initialParticipants: ParticipantRow[];
  isHost: boolean;
  viewerId: string;
}) {
  const [participants, setParticipants] = useState(initialParticipants);

  useEffect(() => {
    let cancelled = false;
    let socket: ReturnType<typeof io> | undefined;

    async function connect() {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      socket = io(process.env.NEXT_PUBLIC_REALTIME_SERVER_URL!, {
        auth: { token },
      });

      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });
      });

      socket.on("participants:update", (rows: ParticipantRow[]) => {
        setParticipants(rows);
      });
    }

    void connect();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [roomId]);

  return (
    <div>
      <h2 className="mb-2 text-sm font-medium">Participants</h2>
      <ul className="flex flex-col gap-1">
        {participants.map((participant) => {
          const isSelf = participant.user_id === viewerId;

          return (
            <li key={participant.user_id} className="flex items-center justify-between text-sm">
              <span>{participant.display_name ?? "Anonymous"}</span>
              {isHost && !isSelf ? (
                <form action={removeParticipant}>
                  <input type="hidden" name="roomId" value={roomId} />
                  <input type="hidden" name="userId" value={participant.user_id} />
                  <button
                    type="submit"
                    className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium dark:border-white/15"
                  >
                    Remove
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
