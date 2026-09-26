"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";

export type LeaderboardRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  total_score: number;
  problems_solved: number;
  last_accepted_at: string | null;
  is_removed: boolean;
};

// Epic 06, Story 2 — layers the live push on top of the SSR'd initial
// rows from app/rooms/[code]/leaderboard/page.tsx: same table, but a
// socket.io connection (Epic 11) replaces the whole row set whenever the
// server pushes a fresh compute_leaderboard() snapshot, instead of the
// page.tsx's own periodic router.refresh() pattern used elsewhere. The
// access token is fetched client-side (this component only ever runs in
// the browser) since the socket handshake needs it, not a server cookie.
export function LiveLeaderboard({
  roomId,
  initialRows,
}: {
  roomId: string;
  initialRows: LeaderboardRow[];
}) {
  const [rows, setRows] = useState(initialRows);
  const router = useRouter();
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

      // Re-joins on every "connect" (including socket.io's own
      // auto-reconnects), not just once — a dropped/reconnected socket
      // otherwise sits in no channel and silently stops receiving pushes.
      //
      // Epic 11, Story 5 — a reconnect (not the initial connect, which the
      // SSR'd initialRows already cover) also re-fetches the current
      // standings directly, rather than trusting that no push was missed
      // while disconnected: compute_leaderboard() only gets called again
      // by the app when a submission is judged, so a client that was
      // offline for a while would otherwise sit on stale rows until the
      // next unrelated verdict lands.
      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });

        if (hasConnectedBefore.current) {
          void supabase
            .rpc("compute_leaderboard", { p_room_id: roomId })
            .then(({ data: freshRows }) => {
              if (!cancelled && freshRows) setRows(freshRows as LeaderboardRow[]);
            });
        }
        hasConnectedBefore.current = true;
      });

      socket.on("leaderboard:update", (updatedRows: LeaderboardRow[]) => {
        setRows(updatedRows);
      });

      // Epic 04, Story 4 — the socket server's /internal/disconnect
      // handler emits this and makes the socket leave the room channel
      // right when a host kicks someone; this is the only place in the
      // app with an open room socket today, so it's the one spot that can
      // react to it live instead of the removed user just sitting on a
      // stale leaderboard until their next page load.
      socket.on("room:kicked", () => {
        router.push("/");
      });
    }

    void connect();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [roomId, router]);

  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">No solves yet this round.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15">
          <th className="py-2 pr-2">#</th>
          <th className="py-2 pr-2">Name</th>
          <th className="py-2 pr-2 text-right">Score</th>
          <th className="py-2 text-right">Solved</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.user_id} className="border-b border-black/5 dark:border-white/10">
            <td className="py-2 pr-2 font-medium">{index + 1}</td>
            <td className="py-2 pr-2">
              {row.display_name ?? "Anonymous"}
              {row.is_removed ? (
                <span className="ml-1 text-xs text-zinc-500">(removed)</span>
              ) : null}
            </td>
            <td className="py-2 pr-2 text-right font-mono">{row.total_score}</td>
            <td className="py-2 text-right">{row.problems_solved}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
