import { resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { SolveScreen } from "@/components/solve-screen";

// Epic 03 — the solve screen, addressed by the room's short invite_code
// in the URL (see docs/SCHEMA.md — the room-centric-rounds design) but
// resolved to the real internal room id immediately, once, here — that
// internal id is what flows into SolveScreen and every API call it
// makes, never the code itself, so nothing downstream needs to care
// which identifier the URL used.
//
// Epic 05, Story 3 — also reads the round's timing so SolveScreen can
// show the same live countdown the room page does; "a countdown is
// visible throughout the session" means while actually solving, not just
// on the room lobby view.
export default async function SolveProblemPage({
  params,
}: {
  params: Promise<{ code: string; slug: string }>;
}) {
  const { code, slug } = await params;
  const roomId = await resolveRoomIdByCode(code);
  await verifyRoomAccess(roomId);

  const supabase = await createClient();
  const { data: room } = await supabase
    .from("rooms")
    .select("round_started_at, round_duration_seconds, round_status")
    .eq("id", roomId)
    .single();

  return (
    <SolveScreen
      roomId={roomId}
      slug={slug}
      roundStartedAt={room?.round_started_at ?? null}
      roundDurationSeconds={room?.round_duration_seconds ?? null}
      roundStatus={(room?.round_status ?? null) as "active" | "ended" | null}
    />
  );
}
