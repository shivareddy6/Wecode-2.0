import { NextResponse } from "next/server";
import { verifySession, getCurrentUser } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { getDecryptedLeetCodeCredentials } from "@/lib/leetcode/credentials";
import { checkSubmissionStatus } from "@/lib/leetcode/client";
import { toVerdict } from "@/lib/leetcode/verdict";
import { broadcastToRoom } from "@/lib/realtime/broadcast";

// Epic 03, Story 3 — the client polls this on an interval while a
// submission is judging. `id` is our own submissions.id now (not
// LeetCode's numeric id); once resolved, this writes the real verdict
// back onto that row — the actual point of the room/session pivot.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await verifySession();
  const { id } = await params;

  const supabase = await createClient();

  const { data: submission } = await supabase
    .from("submissions")
    .select("leetcode_submission_id, room_id, problem_slug, difficulty, is_out_of_contest")
    .eq("id", id)
    .maybeSingle();

  if (!submission?.leetcode_submission_id) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Decrypt-only — no separate live "still signed in" check on every poll
  // tick. checkSubmissionStatus() below is the real test; a dead session
  // surfaces there instead.
  const credentials = await getDecryptedLeetCodeCredentials(user.id);

  if (!credentials) {
    return NextResponse.json(
      { error: "leetcode_session_stale", message: "Reconnect your LeetCode account." },
      { status: 401 },
    );
  }

  let status;
  try {
    status = await checkSubmissionStatus(submission.leetcode_submission_id, credentials);
  } catch {
    return NextResponse.json(
      { error: "Couldn't check submission status. Try again." },
      { status: 502 },
    );
  }

  if (status.state === "SUCCESS" || status.state === "FAILURE") {
    await supabase
      .from("submissions")
      .update({ verdict: toVerdict(status.statusMessage), judged_at: new Date().toISOString() })
      .eq("id", id);

    // Epic 06, Story 2 — push the freshly-recomputed leaderboard right
    // after the verdict that could have changed it lands, instead of
    // leaving other participants to find out on their next page load.
    // Recomputing via the same compute_leaderboard() RPC the static page
    // uses (rather than deriving a delta here) keeps scoring logic in
    // exactly one place.
    const { data: rows } = await supabase.rpc("compute_leaderboard", {
      p_room_id: submission.room_id,
    });
    await broadcastToRoom(submission.room_id, "leaderboard:update", rows ?? []);

    // Epic 07, Story 5 — a system-style chat entry for this submission,
    // attributed to the submitter but kind: "submission" (chat_submission_
    // activity migration) so components/chat.tsx renders it distinctly
    // from a typed message, with is_out_of_contest denormalized straight
    // from the submission row for the "visibly marked" half of the AC.
    // Looked up via current_problems rather than a stored title, since
    // submissions only ever carries problem_slug/difficulty; falls back to
    // the slug itself if the round has already moved on by the time this
    // judges (current_problems is wholesale-replaced every round).
    const { data: room } = await supabase
      .from("rooms")
      .select("current_problems")
      .eq("id", submission.room_id)
      .single();
    const currentProblems = (room?.current_problems ?? []) as Array<{ slug: string; title: string }>;
    const problemTitle =
      currentProblems.find((problem) => problem.slug === submission.problem_slug)?.title ??
      submission.problem_slug;

    const submitter = await getCurrentUser();
    const activityBody =
      status.statusMessage === "Accepted"
        ? `${submitter.displayName ?? "Someone"} solved ${problemTitle} (${submission.difficulty})`
        : `${submitter.displayName ?? "Someone"} attempted ${problemTitle} — ${status.statusMessage}`;

    const { data: chatMessage, error: chatError } = await supabase
      .from("chat_messages")
      .insert({
        room_id: submission.room_id,
        user_id: user.id,
        body: activityBody,
        kind: "submission",
        is_out_of_contest: submission.is_out_of_contest,
      })
      .select("id, room_id, user_id, body, created_at, kind, is_out_of_contest")
      .single();

    if (!chatError && chatMessage) {
      await broadcastToRoom(submission.room_id, "chat:message", {
        id: chatMessage.id,
        room_id: chatMessage.room_id,
        user_id: chatMessage.user_id,
        body: chatMessage.body,
        created_at: chatMessage.created_at,
        kind: chatMessage.kind,
        is_out_of_contest: chatMessage.is_out_of_contest,
        display_name: submitter.displayName,
        avatar_url: submitter.avatarUrl,
      });
    }
  }

  return NextResponse.json({
    state: status.state,
    statusMessage: status.statusMessage,
    totalCorrect: status.totalCorrect,
    totalTestcases: status.totalTestcases,
    runtimeError: status.runtimeError,
    lastTestcase: status.lastTestcase,
    expectedOutput: status.expectedOutput,
    codeOutput: status.codeOutput,
  });
}
