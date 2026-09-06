import Link from "next/link";
import { redirect } from "next/navigation";
import { lookupRoomForJoin, resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { PROBLEM_CATALOG } from "@/lib/problems/catalog";
import { startRound, joinRoom } from "@/app/rooms/actions";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";

type CurrentProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };

// Epic 04, Story 1/2/3/6 (minimal) — room info, joining, and, for the
// host, starting a round. Addressed by the room's short invite_code, not
// its internal UUID — a long UUID in every room-scoped URL was the actual
// complaint, and invite_code already exists/is already unique, so this
// reuses it rather than adding anything new. No live participant list or
// moderation yet — those are real Epic 04 stories, not touched by this
// pass. No session history list either: a room has exactly one current
// round, not a growing list of past ones (see docs/SCHEMA.md — the
// room-centric-rounds design).
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  // Epic 04, Story 2 — logged out: route through the same LeetCode sync
  // form the landing page uses, unmodified. Syncing calls router.refresh(),
  // which just re-runs this Server Component on the same URL — once a
  // session exists, the branch below runs and joins automatically, so
  // there's no separate "click join" step or redirect-back parameter to
  // wire up. Checked before verifySession() would otherwise redirect a
  // signed-out visitor to "/", losing the invite code entirely.
  if (!authData.user) {
    const room = await lookupRoomForJoin(code);
    if (!room) {
      redirect("/");
    }

    return (
      <main className="mx-auto flex max-w-md flex-col gap-8 p-8">
        <div>
          <h1 className="text-xl font-semibold">Join room</h1>
          <p className="text-sm text-zinc-500">
            Sync your LeetCode session to join — no separate signup. You’ll
            land in the room automatically once you’re synced.
          </p>
        </div>
        <LeetCodeSyncForm />
      </main>
    );
  }

  // Epic 04, Story 2 — logged in: join automatically (a no-op if already a
  // member or the host). Failures (room closed, room full, unknown code)
  // surface as a thrown Error/redirect rather than a dedicated error UI,
  // matching this codebase's current bare-minimum error handling elsewhere
  // (e.g. startRound) — a friendlier error screen is later polish.
  await joinRoom(code);

  const roomId = await resolveRoomIdByCode(code);
  const { isHost } = await verifyRoomAccess(roomId);

  const { data: room } = await supabase
    .from("rooms")
    .select("status, current_problems, round_status, used_leetcode_slugs")
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
          Invite code: <code className="font-mono">{code}</code> ({room?.status})
        </p>
      </div>

      {isHost ? (
        availableCatalog.length > 0 ? (
          <form action={startRound} className="flex flex-col gap-3">
            <input type="hidden" name="roomId" value={roomId} />
            <input type="hidden" name="code" value={code} />
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
                <Link href={`/rooms/${code}/solve/${problem.slug}`} className="text-sm underline">
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
