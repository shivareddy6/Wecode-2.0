"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import * as Popover from "@radix-ui/react-popover";
import { createClient } from "@/lib/supabase/client";
import { removeParticipant, transferHost } from "@/app/rooms/actions";
import { Avatar } from "@/components/avatar";

export type ParticipantRow = {
  user_id: string;
  display_name: string | null;
  leetcode_username: string;
  avatar_url: string | null;
};

// Epic 04, Story 3 — live-updating roster for everyone in the room, not
// just the host-only static list Story 4 shipped with. Same socket
// pattern as LiveLeaderboard: connect, join the room channel on every
// "connect" (including auto-reconnects), replace the whole row set
// whenever the server pushes a fresh "participants:update" (from
// joinRoom/removeParticipant in app/rooms/actions.ts).
//
// Shown as a row of avatars, not a listed roster — hovering one gives an
// instant name/username tooltip, clicking opens a small card with the
// host-only actions (Make host / Kick) instead of every participant's
// name and buttons always taking up vertical space in the side panel.
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
            .select("user_id, users(display_name, leetcode_username, avatar_url)")
            .eq("room_id", roomId)
            .is("removed_at", null)
            .then(({ data: rows }) => {
              if (cancelled || !rows) return;
              setParticipants(
                rows.map((row) => {
                  const user = Array.isArray(row.users) ? row.users[0] : row.users;
                  return {
                    user_id: row.user_id,
                    display_name: user?.display_name ?? null,
                    leetcode_username: user?.leetcode_username ?? "",
                    avatar_url: user?.avatar_url ?? null,
                  };
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
      <div className="flex flex-wrap gap-2">
        {participants.map((participant) => (
          <ParticipantAvatar
            key={participant.user_id}
            roomId={roomId}
            participant={participant}
            isViewerHost={isHost}
            isSelf={participant.user_id === viewerId}
            isCurrentHost={participant.user_id === hostUserId}
          />
        ))}
      </div>
    </div>
  );
}

function ParticipantAvatar({
  roomId,
  participant,
  isViewerHost,
  isSelf,
  isCurrentHost,
}: {
  roomId: string;
  participant: ParticipantRow;
  isViewerHost: boolean;
  isSelf: boolean;
  isCurrentHost: boolean;
}) {
  const name = participant.display_name || participant.leetcode_username;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" title={name} className="rounded-full">
          <Avatar
            avatarUrl={participant.avatar_url}
            displayName={participant.display_name}
            username={participant.leetcode_username}
            className="h-8 w-8 text-xs"
          />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          className="w-56 rounded-md border border-border bg-panel p-3 shadow-lg"
        >
          <div className="flex items-center gap-3">
            <Avatar
              avatarUrl={participant.avatar_url}
              displayName={participant.display_name}
              username={participant.leetcode_username}
              className="h-10 w-10 text-sm"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {name}
                {isCurrentHost ? <span className="ml-1.5 rounded bg-panel-raised px-1.5 py-0.5 text-xs text-muted">Host</span> : null}
              </p>
              <p className="truncate text-xs text-muted">{participant.leetcode_username}</p>
            </div>
          </div>

          {isViewerHost && !isSelf ? (
            <div className="mt-3 flex gap-2 border-t border-border pt-3">
              {!isCurrentHost ? (
                <form action={transferHost} className="flex-1">
                  <input type="hidden" name="roomId" value={roomId} />
                  <input type="hidden" name="userId" value={participant.user_id} />
                  <button
                    type="submit"
                    className="w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:bg-panel-raised"
                  >
                    Make host
                  </button>
                </form>
              ) : null}
              <form action={removeParticipant} className="flex-1">
                <input type="hidden" name="roomId" value={roomId} />
                <input type="hidden" name="userId" value={participant.user_id} />
                <button
                  type="submit"
                  className="w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium text-danger hover:bg-danger-bg"
                >
                  Kick
                </button>
              </form>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
