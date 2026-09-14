import Link from "next/link";
import { resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

type LeaderboardRow = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  total_score: number;
  problems_solved: number;
  last_accepted_at: string | null;
};

// Epic 06, Story 1 — plain server-rendered standings for the room's
// *current* round (compute_leaderboard() is room-scoped, not
// session-scoped — see docs/SCHEMA.md's "leaderboard: a function, not a
// table"). Deliberately not live-updating: that's Epic 11's socket push
// (Story 2), layered on top of this once it exists, the same "static
// server-render first" order the room page's countdown already
// established with its periodic router.refresh(). The host competes here
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

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Leaderboard</h1>
        <p className="text-sm text-zinc-500">
          <Link href={`/rooms/${code}`} className="underline">
            Back to room
          </Link>{" "}
          · Invite code: <code className="font-mono">{code}</code>
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No solves yet this round.</p>
      ) : (
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
                <td className="py-2 pr-2">{row.display_name ?? "Anonymous"}</td>
                <td className="py-2 pr-2 text-right font-mono">{row.total_score}</td>
                <td className="py-2 text-right">{row.problems_solved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
