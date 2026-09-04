import { verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { PROBLEM_CATALOG } from "@/lib/problems/catalog";
import { startSession } from "@/app/rooms/actions";
import Link from "next/link";

// Epic 04, Story 1/3/6 (minimal) — room info, current sessions, and (for
// the host) starting a new one. No invite-link joining, live participant
// list, moderation, or closing yet — those are real Epic 04 stories, not
// touched by this pass.
export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const { isHost } = await verifyRoomAccess(roomId);
  const supabase = await createClient();

  const { data: room } = await supabase
    .from("rooms")
    .select("invite_code, status")
    .eq("id", roomId)
    .single();

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, status, started_at")
    .eq("room_id", roomId)
    .order("started_at", { ascending: false });

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Room</h1>
        <p className="text-sm text-zinc-500">
          Invite code: <code className="font-mono">{room?.invite_code}</code> ({room?.status})
        </p>
      </div>

      {isHost ? (
        <form action={startSession} className="flex flex-col gap-3">
          <input type="hidden" name="roomId" value={roomId} />
          <label className="text-sm font-medium">Start a session</label>
          <select
            name="slug"
            required
            className="rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          >
            {PROBLEM_CATALOG.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.title} ({entry.difficulty})
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background self-start"
          >
            Start
          </button>
        </form>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-medium">Sessions</h2>
        <ul className="flex flex-col gap-1">
          {sessions?.map((session) => (
            <li key={session.id}>
              <Link href={`/rooms/${roomId}/sessions/${session.id}`} className="text-sm underline">
                {new Date(session.started_at).toLocaleString()} — {session.status}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
