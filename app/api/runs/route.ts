import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { getValidLeetCodeCredentials, LeetCodeUnavailableError } from "@/lib/leetcode/credentials";
import {
  interpretSolution,
  LeetCodeRateLimitError,
  LeetCodeSessionExpiredError,
} from "@/lib/leetcode/client";
import { isSupportedLanguage, LEETCODE_LANG_SLUG } from "@/lib/leetcode/languages";

type CurrentProblem = { slug: string; title: string; difficulty: string };

// "Run" against example/custom test cases — LeetCode's interpret_solution
// endpoint, distinct from submit/. Nothing gets persisted: the result is
// shown once and discarded, exactly like LeetCode's own Run button.
export async function POST(request: Request) {
  const { user } = await verifySession();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { roomId, slug, questionId, language, code, dataInput } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (
    typeof roomId !== "string" ||
    typeof slug !== "string" ||
    typeof questionId !== "string" ||
    typeof language !== "string" ||
    typeof code !== "string" ||
    typeof dataInput !== "string" ||
    !roomId ||
    !slug ||
    !questionId ||
    !code.trim() ||
    !dataInput.trim() ||
    !isSupportedLanguage(language)
  ) {
    return NextResponse.json({ error: "Invalid run request." }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("current_problems")
    .eq("id", roomId)
    .maybeSingle();

  const currentProblems = (room?.current_problems ?? []) as CurrentProblem[];
  const isCurrent = currentProblems.some((p) => p.slug === slug);

  if (!room || !isCurrent) {
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
      { error: "leetcode_session_stale", message: "Reconnect your LeetCode account to run code." },
      { status: 401 },
    );
  }

  try {
    const result = await interpretSolution(
      slug,
      LEETCODE_LANG_SLUG[language],
      code,
      questionId,
      dataInput,
      credentials,
    );

    return NextResponse.json({ interpretId: result.interpretId });
  } catch (error) {
    if (error instanceof LeetCodeSessionExpiredError) {
      return NextResponse.json(
        { error: "leetcode_session_stale", message: "Reconnect your LeetCode account to run code." },
        { status: 401 },
      );
    }

    if (error instanceof LeetCodeRateLimitError) {
      return NextResponse.json(
        {
          error: "leetcode_rate_limited",
          message: "LeetCode is rate-limiting requests right now — try again shortly.",
          retryAfterSeconds: 15,
        },
        { status: 429 },
      );
    }

    return NextResponse.json({ error: "Couldn't run against LeetCode. Try again." }, { status: 502 });
  }
}
