import { resolveRoomIdByCode, verifyRoomAccess, getCurrentUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { SolveWorkspace } from "@/components/solve/solve-workspace";
import { CHAT_HISTORY_LIMIT } from "@/lib/chat/constants";
import { sortByDifficulty } from "@/lib/problems/difficulty-order";

type CurrentProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };

// The solve workspace, addressed by the room's short invite_code in the
// URL (see docs/SCHEMA.md — the room-centric-rounds design) but resolved
// to the real internal room id immediately, once, here. Fetches the same
// breadth of room state the room page does (current_problems, roster,
// chat history) — the workspace's problem-tab strip and side panel need
// all of it, not just the single slug the old solve screen used to.
export default async function SolveProblemPage({
  params,
}: {
  params: Promise<{ code: string; slug: string }>;
}) {
  const { code, slug } = await params;
  const roomId = await resolveRoomIdByCode(code);
  const { user, isHost } = await verifyRoomAccess(roomId);
  const viewer = await getCurrentUser();

  const supabase = await createClient();
  const { data: room } = await supabase
    .from("rooms")
    .select("current_problems, round_started_at, round_duration_seconds, round_status, host_user_id")
    .eq("id", roomId)
    .single();

  const currentProblems = sortByDifficulty((room?.current_problems ?? []) as CurrentProblem[]);

  const { data: participantRows } = await supabase
    .from("room_participants")
    .select("user_id, users(display_name, leetcode_username, avatar_url)")
    .eq("room_id", roomId)
    .is("removed_at", null);

  const participants = (participantRows ?? []).map((row) => {
    const participantUser = Array.isArray(row.users) ? row.users[0] : row.users;
    return {
      user_id: row.user_id,
      display_name: participantUser?.display_name ?? null,
      leetcode_username: participantUser?.leetcode_username ?? "",
      avatar_url: participantUser?.avatar_url ?? null,
    };
  });

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
      const sender = Array.isArray(row.users) ? row.users[0] : row.users;
      return {
        id: row.id,
        user_id: row.user_id,
        display_name: sender?.display_name ?? null,
        leetcode_username: sender?.leetcode_username ?? "",
        avatar_url: sender?.avatar_url ?? null,
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

  return (
    <SolveWorkspace
      roomId={roomId}
      code={code}
      initialSlug={slug}
      problems={currentProblems}
      roundStartedAt={room?.round_started_at ?? null}
      roundDurationSeconds={room?.round_duration_seconds ?? null}
      roundStatus={(room?.round_status ?? null) as "active" | "ended" | null}
      viewerId={user.id}
      viewerDisplayName={viewer.displayName}
      viewerLeetcodeUsername={viewer.leetcodeUsername}
      viewerAvatarUrl={viewer.avatarUrl}
      isHost={isHost}
      hostUserId={room?.host_user_id ?? ""}
      initialParticipants={participants}
      initialChatMessages={chatMessages}
    />
  );
}
