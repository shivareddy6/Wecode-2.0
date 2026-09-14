import { NextResponse } from "next/server";
import { verifySession } from "@/lib/dal";
import { getDecryptedLeetCodeCredentials } from "@/lib/leetcode/credentials";
import { checkInterpretStatus } from "@/lib/leetcode/client";

// Polled while a Run is judging. `id` here is LeetCode's own interpret id
// (never stored — see app/api/runs/route.ts), so there's no DB lookup at
// all, unlike the submissions status route.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await verifySession();
  const { id } = await params;

  const credentials = await getDecryptedLeetCodeCredentials(user.id);

  if (!credentials) {
    return NextResponse.json(
      { error: "leetcode_session_stale", message: "Reconnect your LeetCode account." },
      { status: 401 },
    );
  }

  let status;
  try {
    status = await checkInterpretStatus(id, credentials);
  } catch {
    return NextResponse.json({ error: "Couldn't check run status. Try again." }, { status: 502 });
  }

  return NextResponse.json(status);
}
