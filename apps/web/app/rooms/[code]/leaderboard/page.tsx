import Link from "next/link";
import { resolveRoomIdByCode, verifyRoomAccess, getCurrentUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ContestLeaderboard, type LeaderboardRow, type BreakdownRow, type LeaderboardProblem } from "@/components/contest-leaderboard";
import { ProfileMenu } from "@/components/solve/profile-menu";
import { sortByDifficulty } from "@/lib/problems/difficulty-order";

// Epic 06, Story 1/2 — server-renders the current standings for the
// room's *current* round (compute_leaderboard() is room-scoped, not
// session-scoped — see docs/SCHEMA.md's "leaderboard: a function, not a
// table") as the initial paint, then hands those rows to <LiveLeaderboard>
// which opens the Epic 11 socket connection and replaces them in place as
// pushes arrive — no polling, no manual refresh. The host competes here
// like anyone else because they hold a real room_participants row from
// create_room() onward, same as everyone else — see docs/SCHEMA.md's
// "Room membership: the host is a participant too".
export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const roomId = await resolveRoomIdByCode(code);
  await verifyRoomAccess(roomId);
  const viewer = await getCurrentUser();

  const supabase = await createClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("current_problems")
    .eq("id", roomId)
    .single();
  const problems = sortByDifficulty((room?.current_problems ?? []) as LeaderboardProblem[]);

  const { data, error } = await supabase.rpc("compute_leaderboard", {
    p_room_id: roomId,
  });

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as LeaderboardRow[];

  // Epic 06, Story 4 — the per-problem breakdown underneath the rollup
  // above. Not part of the live socket push (that's just total_score/
  // problems_solved, Story 2) — this re-renders on the page's own
  // server-render cycle, which is fine since it's meant to be read as
  // much after a round ends as during it.
  const { data: breakdownData, error: breakdownError } = await supabase.rpc(
    "compute_leaderboard_breakdown",
    { p_room_id: roomId },
  );

  if (breakdownError) {
    throw new Error(breakdownError.message);
  }

  const breakdownRows = (breakdownData ?? []) as BreakdownRow[];

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-panel px-4 py-2">
        <div className="flex items-center gap-3 text-sm">
          <Link href={`/rooms/${code}`} className="text-muted hover:text-foreground">
            ← Room
          </Link>
          <span className="text-muted">·</span>
          <code className="font-mono text-muted">{code}</code>
        </div>
        <ProfileMenu displayName={viewer.displayName} leetcodeUsername={viewer.leetcodeUsername} avatarUrl={viewer.avatarUrl} />
      </div>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
        <h1 className="text-xl font-semibold">Leaderboard</h1>
        <div className="overflow-x-auto rounded-lg border border-border bg-panel p-5">
          <ContestLeaderboard roomId={roomId} problems={problems} initialRows={rows} initialBreakdownRows={breakdownRows} />
        </div>
      </main>
    </div>
  );
}
