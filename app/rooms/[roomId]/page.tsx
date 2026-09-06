import Link from "next/link";
import { verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { PROBLEM_CATALOG } from "@/lib/problems/catalog";
import { startRound } from "@/app/rooms/actions";

type CurrentProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };

// Epic 04, Story 1/3/6 (minimal) — room info and, for the host, starting a
// round. No invite-link joining, live participant list, or moderation yet
// — those are real Epic 04 stories, not touched by this pass. No session
// history list either: a room has exactly one current round, not a
// growing list of past ones (see docs/SCHEMA.md — the room-centric-rounds
// design).
export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const { isHost } = await verifyRoomAccess(roomId);
  const supabase = await createClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("invite_code, status, current_problems, round_status, used_leetcode_slugs")
    .eq("id", roomId)
    .single();

  const currentProblems = (room?.current_problems ?? []) as CurrentProblem[];
  const usedSlugs = room?.used_leetcode_slugs ?? [];
  const availableCatalog = PROBLEM_CATALOG.filter((entry) => !usedSlugs.includes(entry.slug));

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Room</h1>
        <p className="text-sm text-zinc-500">
          Invite code: <code className="font-mono">{room?.invite_code}</code> ({room?.status})
        </p>
      </div>

      {isHost ? (
        availableCatalog.length > 0 ? (
          <form action={startRound} className="flex flex-col gap-3">
            <input type="hidden" name="roomId" value={roomId} />
            <label className="text-sm font-medium">Start a round</label>
            <select
              name="slug"
              required
              className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {availableCatalog.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.title} ({entry.difficulty})
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background self-start"
            >
              Start
            </button>
          </form>
        ) : (
          <p className="text-sm text-zinc-500">
            No new problems left in the catalog — every problem has already been used in this room.
          </p>
        )
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-medium">
          Current round {room?.round_status ? `(${room.round_status})` : null}
        </h2>
        {currentProblems.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {currentProblems.map((problem) => (
              <li key={problem.slug}>
                <Link href={`/rooms/${roomId}/solve/${problem.slug}`} className="text-sm underline">
                  {problem.title} ({problem.difficulty})
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No round started yet.</p>
        )}
      </div>
    </main>
  );
}
