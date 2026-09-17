import Link from "next/link";
import { resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { LiveLeaderboard, type LeaderboardRow } from "@/components/live-leaderboard";
import { ProblemBreakdown, type BreakdownRow } from "@/components/problem-breakdown";

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

  const supabase = await createClient();
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
  const displayNames = Object.fromEntries(
    rows.map((row) => [row.user_id, row.display_name]),
  );

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-10 p-8">
      <div>
        <h1 className="text-xl font-semibold">Leaderboard</h1>
        <p className="text-sm text-zinc-500">
          <Link href={`/rooms/${code}`} className="underline">
            Back to room
          </Link>{" "}
          · Invite code: <code className="font-mono">{code}</code>
        </p>
      </div>

      <LiveLeaderboard roomId={roomId} initialRows={rows} />

      <ProblemBreakdown
        rows={breakdownRows}
        participantOrder={rows.map((row) => row.user_id)}
        displayNames={displayNames}
      />
    </main>
  );
}
