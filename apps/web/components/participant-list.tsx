"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import { removeParticipant, transferHost } from "@/app/rooms/actions";

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
  hostUserId,
}: {
  roomId: string;
  initialParticipants: ParticipantRow[];
  isHost: boolean;
  viewerId: string;
  hostUserId: string;
}) {
  const [participants, setParticipants] = useState(initialParticipants);
  const hasConnectedBefore = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let socket: ReturnType<typeof io> | undefined;
    hasConnectedBefore.current = false;

    async function connect() {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      socket = io(process.env.NEXT_PUBLIC_REALTIME_SERVER_URL!, {
        auth: { token },
      });

      // Epic 11, Story 5 — a reconnect re-fetches the current roster
      // directly instead of assuming no "participants:update" was missed
      // while disconnected (the initial connect is already covered by the
      // SSR'd initialParticipants).
      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });

        if (hasConnectedBefore.current) {
          void supabase
            .from("room_participants")
            .select("user_id, users(display_name)")
            .eq("room_id", roomId)
            .is("removed_at", null)
            .then(({ data: rows }) => {
              if (cancelled || !rows) return;
              setParticipants(
                rows.map((row) => {
                  const user = Array.isArray(row.users) ? row.users[0] : row.users;
                  return { user_id: row.user_id, display_name: user?.display_name ?? null };
                }),
              );
            });
        }
        hasConnectedBefore.current = true;
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

          const isCurrentHost = participant.user_id === hostUserId;

          return (
            <li key={participant.user_id} className="flex items-center justify-between text-sm">
              <span>
                {participant.display_name ?? "Anonymous"}
                {isCurrentHost ? " (Host)" : null}
              </span>
              {isHost && !isSelf ? (
                <div className="flex gap-2">
                  {!isCurrentHost ? (
                    <form action={transferHost}>
                      <input type="hidden" name="roomId" value={roomId} />
                      <input type="hidden" name="userId" value={participant.user_id} />
                      <button
                        type="submit"
                        className="rounded-full border border-black/10 px-3 py-1 text-xs font-medium dark:border-white/15"
                      >
                        Make host
                      </button>
                    </form>
                  ) : null}
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
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
