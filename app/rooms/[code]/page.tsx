import Link from "next/link";
import { redirect } from "next/navigation";
import { lookupRoomForJoin, resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ROUND_PRESETS } from "@/lib/problems/round-selection";
import { computeRoundDeadline, isPastDeadline } from "@/lib/rounds/deadline";
import { startRound, joinRoom, endRound } from "@/app/rooms/actions";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";
import { RoundCountdown } from "@/components/round-countdown";

type CurrentProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };

const DEFAULT_DURATION_MINUTES = 30;

// Epic 04, Story 1/2/3/6 + Epic 05, Story 1/2/3/6/7 (real pass) — room
// info, joining, and, for the host, starting/ending a round with a real
// preset + duration + random selection instead of the old single-slug
// dropdown. Addressed by the room's short invite_code, not its internal
// UUID (see docs/SCHEMA.md — the room-centric-rounds design). No live
// participant list or moderation yet — those are Epic 04, Stories 3/4/5,
// not touched by this pass. No session history list either: a room has
// exactly one current round, not a growing list of past ones.
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
    .select(
      "status, current_problems, round_status, round_started_at, round_duration_seconds, round_preset",
    )
    .eq("id", roomId)
    .single();

  const currentProblems = (room?.current_problems ?? []) as CurrentProblem[];

  // Epic 05, Story 5 — nothing pushes a round's timer expiring; it's
  // detected here (or in app/api/submissions/route.ts, on a late attempt)
  // and lazily written back via finalize_expired_round so round_status
  // converges to 'ended' instead of staying stuck on a stale 'active'. The
  // deadline math itself is duplicated client-side in RoundCountdown —
  // both read the same round_started_at/round_duration_seconds, so they
  // can't disagree about *when* the round ends, only about whether the DB
  // row has caught up to that fact yet.
  const deadline = computeRoundDeadline(room?.round_started_at ?? null, room?.round_duration_seconds ?? null);
  const isExpired = isPastDeadline(deadline);

  if (room?.round_status === "active" && isExpired) {
    await supabase.rpc("finalize_expired_round", { p_room_id: roomId });
  }

  const effectiveRoundStatus = (
    room?.round_status === "active" && isExpired ? "ended" : room?.round_status ?? null
  ) as "active" | "ended" | null;

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Room</h1>
        <p className="text-sm text-zinc-500">
          Invite code: <code className="font-mono">{code}</code> ({room?.status}) ·{" "}
          <Link href={`/rooms/${code}/leaderboard`} className="underline">
            Leaderboard
          </Link>
        </p>
      </div>

      {isHost ? (
        <div className="flex flex-col gap-3">
          <form action={startRound} className="flex flex-col gap-3">
            <input type="hidden" name="roomId" value={roomId} />
            <input type="hidden" name="code" value={code} />
            <label className="text-sm font-medium">Start a round</label>
            <select
              name="preset"
              required
              defaultValue="warm_up"
              className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {Object.entries(ROUND_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.label} ({preset.description})
                </option>
              ))}
            </select>
            <label className="text-sm font-medium">Duration (minutes)</label>
            <input
              type="number"
              name="durationMinutes"
              min={5}
              max={180}
              defaultValue={DEFAULT_DURATION_MINUTES}
              required
              className="w-32 rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            />
            <button
              type="submit"
              className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background self-start"
            >
              Start
            </button>
          </form>

          {effectiveRoundStatus === "active" ? (
            <form action={endRound}>
              <input type="hidden" name="roomId" value={roomId} />
              <button
                type="submit"
                className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium self-start dark:border-white/15"
              >
                End round early
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">
            Current round {effectiveRoundStatus ? `(${effectiveRoundStatus})` : null}
          </h2>
          <RoundCountdown
            roundStartedAt={room?.round_started_at ?? null}
            roundDurationSeconds={room?.round_duration_seconds ?? null}
            roundStatus={effectiveRoundStatus}
          />
        </div>
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
