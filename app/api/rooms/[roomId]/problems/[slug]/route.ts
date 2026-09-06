import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { getValidLeetCodeCredentials, LeetCodeUnavailableError } from "@/lib/leetcode/credentials";
import { fetchProblem } from "@/lib/leetcode/client";
import { SUPPORTED_LANGUAGES, LEETCODE_LANG_SLUG } from "@/lib/leetcode/languages";

type CurrentProblem = { slug: string; title: string; difficulty: string };

// Epic 03, Story 1/4 — real problem content plus per-language starter
// code, addressed by room + slug directly (see docs/SCHEMA.md — the
// room-centric-rounds design replaced session_problems).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ roomId: string; slug: string }> },
) {
  const { user } = await verifySession();
  const { roomId, slug } = await params;

  const supabase = await createClient();

  // RLS on rooms already restricts this to room members/hosts — a null
  // result means either the room doesn't exist or the caller can't see
  // it, and both get the same 404, so neither leaks to the other.
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
      { error: "leetcode_session_stale", message: "Reconnect your LeetCode account to solve problems." },
      { status: 401 },
    );
  }

  let problem;
  try {
    problem = await fetchProblem(slug, credentials);
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach LeetCode. Try again in a moment." },
      { status: 502 },
    );
  }

  if (!problem) {
    return NextResponse.json({ error: "Problem not found on LeetCode." }, { status: 404 });
  }

  const snippetsByLangSlug = new Map(
    problem.codeSnippets.map((snippet) => [snippet.langSlug, snippet.code]),
  );

  return NextResponse.json({
    questionId: problem.questionId,
    title: problem.title,
    difficulty: problem.difficulty,
    content: problem.content,
    exampleTestcases: problem.exampleTestcases,
    languages: SUPPORTED_LANGUAGES.map((language) => ({
      language,
      starterCode: snippetsByLangSlug.get(LEETCODE_LANG_SLUG[language]) ?? null,
    })),
  });
}
