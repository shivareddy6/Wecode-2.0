import Link from "next/link";
import { redirect } from "next/navigation";
import { lookupRoomForJoin, resolveRoomIdByCode, verifyRoomAccess, getCurrentUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { ROUND_PRESETS } from "@/lib/problems/round-selection";
import { computeRoundDeadline, isPastDeadline } from "@/lib/rounds/deadline";
import { startRound, joinRoom, endRound, closeRoom, regenerateInviteLink } from "@/app/rooms/actions";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";
import { RoundCountdown } from "@/components/round-countdown";
import { ParticipantList } from "@/components/participant-list";
import { Chat } from "@/components/chat";
import { ProfileMenu } from "@/components/solve/profile-menu";
import { sortByDifficulty } from "@/lib/problems/difficulty-order";
import { CHAT_HISTORY_LIMIT } from "@/lib/chat/constants";

const DIFFICULTY_COLOR: Record<string, string> = {
  easy: "text-success",
  medium: "text-warning",
  hard: "text-danger",
};

type CurrentProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };

const DEFAULT_DURATION_MINUTES = 30;

// Epic 04, Story 1/2/3/4/5/6 + Epic 05, Story 1/2/3/6/7 (real pass) —
// room info, joining, a live-updating roster for everyone (Story 3),
// host-only start/end round with a real preset + duration + random
// selection, and host-only room close (Story 5). Addressed by the room's
// short invite_code, not its internal UUID (see docs/SCHEMA.md — the
// room-centric-rounds design). No session history list either: a room
// has exactly one current round, not a growing list of past ones.
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
          <p className="text-sm text-muted">
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
      "status, current_problems, round_status, round_started_at, round_duration_seconds, round_preset, host_user_id",
    )
    .eq("id", roomId)
    .single();

  const currentProblems = sortByDifficulty((room?.current_problems ?? []) as CurrentProblem[]);
  const viewer = await getCurrentUser();

  // Epic 04, Story 3 — the full roster, visible to every member (not just
  // the host), same visibility model as the leaderboard. ParticipantList
  // below takes this as its initial render and replaces it live over the
  // socket on every "participants:update" push.
  const { data: participantRows } = await supabase
    .from("room_participants")
    .select("user_id, users(display_name, leetcode_username, avatar_url)")
    .eq("room_id", roomId)
    .is("removed_at", null);

  const participants = (participantRows ?? []).map((row) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    return {
      user_id: row.user_id,
      display_name: user?.display_name ?? null,
      leetcode_username: user?.leetcode_username ?? "",
      avatar_url: user?.avatar_url ?? null,
    };
  });

  // Epic 07, Story 1 — chat history so far, visible to anyone landing on
  // the room later (spans rounds, unlike current_problems — see
  // docs/SCHEMA.md's "Chat spans rounds regardless" note). Soft-deleted
  // rows (Story 3) are excluded here the same way a removed participant is
  // excluded from the roster above. Capped at the most recent 100 — this is
  // a casual friends tool, not a paginated archive.
  const { data: chatRows } = await supabase
    .from("chat_messages")
    .select(
      "id, user_id, body, created_at, kind, is_out_of_contest, problem_title, problem_difficulty, is_solved, users(display_name, leetcode_username, avatar_url)",
    )
    .eq("room_id", roomId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(CHAT_HISTORY_LIMIT);

  const chatMessages = (chatRows ?? [])
    .map((row) => {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      return {
        id: row.id,
        user_id: row.user_id,
        display_name: user?.display_name ?? null,
        leetcode_username: user?.leetcode_username ?? "",
        avatar_url: user?.avatar_url ?? null,
        body: row.body,
        created_at: row.created_at,
        kind: row.kind as "user" | "submission",
        is_out_of_contest: row.is_out_of_contest,
        problem_title: row.problem_title,
        problem_difficulty: row.problem_difficulty as "easy" | "medium" | "hard" | null,
        is_solved: row.is_solved,
      };
    })
    .reverse();

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
    <div className="flex min-h-screen flex-col md:h-screen md:overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-panel px-4 py-2">
        <div className="flex items-center gap-3 text-sm">
          <Link href="/" className="font-semibold">
            We<span className="text-accent">Code</span>
          </Link>
          <span className="text-muted">·</span>
          <code className="font-mono text-muted">{code}</code>
          <span className="rounded-full bg-panel-raised px-2 py-0.5 text-xs text-muted">{room?.status}</span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/rooms/${code}/leaderboard`}
            className="rounded-full border border-border px-3 py-1.5 text-sm font-medium hover:bg-panel-raised"
          >
            Leaderboard
          </Link>
          <ProfileMenu
            displayName={viewer.displayName}
            leetcodeUsername={viewer.leetcodeUsername}
            avatarUrl={viewer.avatarUrl}
          />
        </div>
      </div>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-3 py-6 md:min-h-0 md:flex-row md:overflow-hidden">
        <div className="flex flex-1 flex-col gap-6 md:min-h-0 md:overflow-y-auto">
          {isHost && room?.status === "open" ? (
            <section className="flex flex-col gap-4 rounded-lg border border-border bg-panel p-5">
              <form action={startRound} className="flex flex-col gap-3">
                <input type="hidden" name="roomId" value={roomId} />
                <input type="hidden" name="code" value={code} />
                <label className="text-sm font-medium">Start a round</label>
                <select
                  name="preset"
                  required
                  defaultValue="warm_up"
                  className="rounded-md border border-border bg-panel-raised px-2 py-1.5 text-sm"
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
                  className="w-32 rounded-md border border-border bg-panel-raised px-2 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  className="self-start rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
                >
                  Start
                </button>
              </form>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {effectiveRoundStatus === "active" ? (
                  <form action={endRound}>
                    <input type="hidden" name="roomId" value={roomId} />
                    <button
                      type="submit"
                      className="rounded-full border border-border px-4 py-1.5 text-sm font-medium hover:bg-panel-raised"
                    >
                      End round early
                    </button>
                  </form>
                ) : null}

                <form action={regenerateInviteLink}>
                  <input type="hidden" name="roomId" value={roomId} />
                  <button
                    type="submit"
                    className="rounded-full border border-border px-4 py-1.5 text-sm font-medium hover:bg-panel-raised"
                  >
                    Regenerate invite link
                  </button>
                </form>

                <form action={closeRoom}>
                  <input type="hidden" name="roomId" value={roomId} />
                  <button
                    type="submit"
                    className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-danger hover:bg-danger-bg"
                  >
                    Close room
                  </button>
                </form>
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-border bg-panel p-5">
            <div className="mb-3 flex items-center justify-between">
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
                {currentProblems.map((problem, index) => (
                  <li key={problem.slug}>
                    <Link
                      href={`/rooms/${code}/solve/${problem.slug}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-panel-raised"
                    >
                      <span className={`font-medium ${DIFFICULTY_COLOR[problem.difficulty]}`}>Q{index + 1}</span>
                      <span>{problem.title}</span>
                      <span className={`text-xs capitalize ${DIFFICULTY_COLOR[problem.difficulty]}`}>
                        {problem.difficulty}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No round started yet.</p>
            )}
          </section>
        </div>

        <div className="flex w-full flex-col gap-4 md:w-[26rem] md:min-h-0 md:shrink-0">
          <section className="shrink-0 rounded-lg border border-border bg-panel p-5">
            <ParticipantList
              roomId={roomId}
              initialParticipants={participants}
              isHost={isHost}
              viewerId={authData.user.id}
              hostUserId={room?.host_user_id ?? ""}
            />
          </section>

          <section className="flex min-h-[32rem] flex-1 flex-col rounded-lg border border-border bg-panel p-5 md:min-h-0">
            <Chat
              roomId={roomId}
              initialMessages={chatMessages}
              isHost={isHost}
              viewerId={authData.user.id}
              listClassName="min-h-0 flex-1"
            />
          </section>
        </div>
      </main>
    </div>
  );
}
