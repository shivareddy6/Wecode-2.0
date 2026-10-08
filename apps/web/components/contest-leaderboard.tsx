"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import { formatMinutesAsClock } from "@/lib/format/minutes";

export type LeaderboardRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  total_score: number;
  problems_solved: number;
  last_accepted_at: string | null;
  total_time_minutes: number;
  is_removed: boolean;
};

export type BreakdownRow = {
  user_id: string;
  problem_slug: string;
  problem_title: string;
  difficulty: string;
  status: "solved" | "solved_out_of_contest" | "not_attempted";
  problem_score: number;
  problem_time_minutes: number | null;
  wrong_before: number | null;
  attempt_count: number;
  is_removed: boolean;
};

export type LeaderboardProblem = { slug: string; title: string; difficulty: string };

// A single wide table — Rank/Name/Score/Time, then one column per round
// problem — matching real LeetCode's contest standings instead of a
// rollup table with a separate per-user breakdown underneath. Column
// order comes from the `problems` prop (the room's current_problems,
// already sorted easy-to-hard by the caller) — the exact same array the
// solve workspace's tabs render from, not a second independent sort over
// breakdown rows, so Q1/Q2/... always matches the tabs by construction.
//
// Owns the live socket connection (absorbing the old LiveLeaderboard's
// job): a "leaderboard:update" push already carries fresh rollup rows,
// but breakdown data isn't pushed at all, so every push also triggers a
// plain re-fetch of compute_leaderboard_breakdown to keep the per-problem
// cells live too — no socket-server change needed for that.
export function ContestLeaderboard({
  roomId,
  problems,
  initialRows,
  initialBreakdownRows,
}: {
  roomId: string;
  problems: LeaderboardProblem[];
  initialRows: LeaderboardRow[];
  initialBreakdownRows: BreakdownRow[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [breakdownRows, setBreakdownRows] = useState(initialBreakdownRows);
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

      socket = io(process.env.NEXT_PUBLIC_REALTIME_SERVER_URL!, { auth: { token } });

      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });

        if (hasConnectedBefore.current) {
          void supabase.rpc("compute_leaderboard", { p_room_id: roomId }).then(({ data: freshRows }) => {
            if (!cancelled && freshRows) setRows(freshRows as LeaderboardRow[]);
          });
          void supabase.rpc("compute_leaderboard_breakdown", { p_room_id: roomId }).then(({ data: freshBreakdown }) => {
            if (!cancelled && freshBreakdown) setBreakdownRows(freshBreakdown as BreakdownRow[]);
          });
        }
        hasConnectedBefore.current = true;
      });

      socket.on("leaderboard:update", (updatedRows: LeaderboardRow[]) => {
        setRows(updatedRows);
        void supabase.rpc("compute_leaderboard_breakdown", { p_room_id: roomId }).then(({ data: freshBreakdown }) => {
          if (!cancelled && freshBreakdown) setBreakdownRows(freshBreakdown as BreakdownRow[]);
        });
      });

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

  const cellsByUser = useMemo(() => {
    const map = new Map<string, Map<string, BreakdownRow>>();
    for (const row of breakdownRows) {
      if (!map.has(row.user_id)) map.set(row.user_id, new Map());
      map.get(row.user_id)!.set(row.problem_slug, row);
    }
    return map;
  }, [breakdownRows]);

  function pointsFor(slug: string): number | null {
    const solved = breakdownRows.find((row) => row.problem_slug === slug && row.problem_score > 0);
    return solved ? solved.problem_score : null;
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted">No solves yet this round.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4 text-right">Score</th>
            <th className="py-2 pr-4 text-right">Time</th>
            {problems.map((col, index) => {
              const points = pointsFor(col.slug);
              return (
                <th key={col.slug} className="py-2 pr-4 text-right" title={col.title}>
                  Q{index + 1}
                  {points !== null ? ` (${points})` : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.user_id} className="border-b border-border/60">
              <td className="py-2 pr-2 font-medium">{index + 1}</td>
              <td className="py-2 pr-4">
                {row.display_name ?? "Anonymous"}
                {row.is_removed ? <span className="ml-1 text-xs text-muted">(removed)</span> : null}
              </td>
              <td className="py-2 pr-4 text-right font-mono">{row.total_score}</td>
              <td className="py-2 pr-4 text-right font-mono text-muted">
                {row.problems_solved > 0 ? formatMinutesAsClock(row.total_time_minutes) : "—"}
              </td>
              {problems.map((col) => {
                const cell = cellsByUser.get(row.user_id)?.get(col.slug);
                if (!cell || (cell.status === "not_attempted" && cell.attempt_count === 0)) {
                  return <td key={col.slug} className="py-2 pr-4 text-right" />;
                }
                if (cell.status === "not_attempted") {
                  return (
                    <td key={col.slug} className="py-2 pr-4 text-right font-mono text-danger">
                      —
                    </td>
                  );
                }
                return (
                  <td key={col.slug} className="py-2 pr-4 text-right font-mono">
                    <span className={cell.status === "solved_out_of_contest" ? "text-muted" : "text-success"}>
                      {formatMinutesAsClock(cell.problem_time_minutes ?? 0)}
                    </span>
                    {cell.wrong_before ? <span className="ml-1 text-xs text-danger">{cell.wrong_before}w</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
