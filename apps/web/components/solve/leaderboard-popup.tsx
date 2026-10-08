"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { createClient } from "@/lib/supabase/client";
import { ContestLeaderboard, type LeaderboardRow, type BreakdownRow } from "@/components/contest-leaderboard";
import type { RoundProblem } from "@/components/solve/problem-panel";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; rows: LeaderboardRow[]; breakdownRows: BreakdownRow[] };

// Leaderboard as a popup, not a separate page — reachable from anywhere in
// the solve workspace (⌘⇧L or the top bar button) instead of leaving the
// editor. Fetches on open rather than preloading, since it may never be
// opened in a given session; <LiveLeaderboard> then takes over its own
// live socket updates for as long as the dialog stays mounted.
export function LeaderboardPopup({
  roomId,
  problems,
  open,
  onOpenChange,
}: {
  roomId: string;
  problems: RoundProblem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });

    async function load() {
      const supabase = createClient();
      const [{ data: rows, error }, { data: breakdownRows, error: breakdownError }] = await Promise.all([
        supabase.rpc("compute_leaderboard", { p_room_id: roomId }),
        supabase.rpc("compute_leaderboard_breakdown", { p_room_id: roomId }),
      ]);

      if (cancelled) return;
      if (error || breakdownError) {
        setState({ kind: "error" });
        return;
      }

      setState({
        kind: "ready",
        rows: (rows ?? []) as LeaderboardRow[],
        breakdownRows: (breakdownRows ?? []) as BreakdownRow[],
      });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, roomId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed top-1/2 left-1/2 max-h-[85vh] w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-panel p-6">
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">Leaderboard</Dialog.Title>
            <Dialog.Close className="text-sm text-muted hover:text-foreground">Close (Esc)</Dialog.Close>
          </div>

          {state.kind === "loading" ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : state.kind === "error" ? (
            <p className="text-sm text-danger">Couldn&apos;t load the leaderboard. Try again.</p>
          ) : (
            <ContestLeaderboard roomId={roomId} problems={problems} initialRows={state.rows} initialBreakdownRows={state.breakdownRows} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
