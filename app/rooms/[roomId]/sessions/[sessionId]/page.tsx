import Link from "next/link";
import { verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";

// Epic 05, Story 4 (minimal) — lists the session's problems. Only ever one
// right now (Story 1/2's real preset + random-selection logic isn't built
// yet), but this shape holds without changes once that lands.
export default async function SessionPage({
  params,
}: {
  params: Promise<{ roomId: string; sessionId: string }>;
}) {
  const { roomId, sessionId } = await params;
  await verifyRoomAccess(roomId);
  const supabase = await createClient();

  const { data: problems } = await supabase
    .from("session_problems")
    .select("id, leetcode_title, difficulty, position")
    .eq("session_id", sessionId)
    .order("position");

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Session</h1>
      <ul className="flex flex-col gap-2">
        {problems?.map((problem) => (
          <li key={problem.id}>
            <Link
              href={`/rooms/${roomId}/sessions/${sessionId}/problems/${problem.id}`}
              className="text-sm underline"
            >
              {problem.leetcode_title} ({problem.difficulty})
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
