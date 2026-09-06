import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import {
  getValidLeetCodeCredentials,
  markLeetCodeSessionStale,
  LeetCodeUnavailableError,
} from "@/lib/leetcode/credentials";
import {
  submitSolution,
  LeetCodeRateLimitError,
  LeetCodeSessionExpiredError,
} from "@/lib/leetcode/client";
import { isSupportedLanguage, LEETCODE_LANG_SLUG } from "@/lib/leetcode/languages";

type CurrentProblem = { slug: string; title: string; difficulty: string };

// Epic 03, Story 2/5/6 — submits to LeetCode's real judge and records a
// real row in public.submissions, addressed by room + slug directly (see
// docs/SCHEMA.md — the room-centric-rounds design). difficulty is looked
// up server-side from rooms.current_problems, never trusted from the
// client, since it feeds the scoring formula. The cooldown check reads
// submissions directly; there's no separate rate-limit table.
const COOLDOWN_SECONDS = 10;

export async function POST(request: Request) {
  const { user } = await verifySession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { roomId, slug, questionId, language, code } = (body ?? {}) as Record<string, unknown>;

  if (
    typeof roomId !== "string" ||
    typeof slug !== "string" ||
    typeof questionId !== "string" ||
    typeof language !== "string" ||
    typeof code !== "string" ||
    !roomId ||
    !slug ||
    !questionId ||
    !code.trim() ||
    !isSupportedLanguage(language)
  ) {
    return NextResponse.json({ error: "Invalid submission." }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("current_problems")
    .eq("id", roomId)
    .maybeSingle();

  const currentProblems = (room?.current_problems ?? []) as CurrentProblem[];
  const problem = currentProblems.find((p) => p.slug === slug);

  if (!room || !problem) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let credentials;
  try {
    credentials = await getValidLeetCodeCredentials(user.id);
  } catch (error) {
    if (error instanceof LeetCodeUnavailableError) {
      return NextResponse.json(
        { error: "Couldn't reach LeetCode to verify your session. Try again in a moment." },
        { status: 502 },
      );
    }
    throw error;
  }

  if (!credentials) {
    return NextResponse.json(
      { error: "leetcode_session_stale", message: "Reconnect your LeetCode account to submit." },
      { status: 401 },
    );
  }

  const { data: recent } = await supabase
    .from("submissions")
    .select("submitted_at")
    .eq("room_id", roomId)
    .eq("problem_slug", slug)
    .eq("user_id", user.id)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent) {
    const elapsedMs = Date.now() - new Date(recent.submitted_at).getTime();
    const remainingMs = COOLDOWN_SECONDS * 1000 - elapsedMs;

    if (remainingMs > 0) {
      const retryAfterSeconds = Math.ceil(remainingMs / 1000);
      return NextResponse.json(
        {
          error: "rate_limited",
          message: `Wait ${retryAfterSeconds}s before resubmitting this problem.`,
          retryAfterSeconds,
        },
        { status: 429 },
      );
    }
  }

  try {
    const result = await submitSolution(
      slug,
      LEETCODE_LANG_SLUG[language],
      code,
      questionId,
      credentials,
    );

    const { data: submission, error: insertError } = await supabase
      .from("submissions")
      .insert({
        room_id: roomId,
        problem_slug: slug,
        difficulty: problem.difficulty,
        user_id: user.id,
        language,
        leetcode_submission_id: result.submissionId,
        verdict: "pending",
      })
      .select("id")
      .single();

    if (insertError || !submission) {
      return NextResponse.json(
        { error: "Submitted to LeetCode but couldn't record it. Try again." },
        { status: 500 },
      );
    }

    return NextResponse.json({ submissionId: submission.id });
  } catch (error) {
    if (error instanceof LeetCodeSessionExpiredError) {
      await markLeetCodeSessionStale(user.id);
      return NextResponse.json(
        { error: "leetcode_session_stale", message: "Reconnect your LeetCode account to submit." },
        { status: 401 },
      );
    }

    if (error instanceof LeetCodeRateLimitError) {
      return NextResponse.json(
        {
          error: "leetcode_rate_limited",
          message: "LeetCode is rate-limiting submissions right now — try again shortly.",
          retryAfterSeconds: 15,
        },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: "Couldn't submit to LeetCode. Try again." },
      { status: 502 },
    );
  }
}
