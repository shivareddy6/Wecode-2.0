import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
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
    .select("leetcode_submission_id, room_id")
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
