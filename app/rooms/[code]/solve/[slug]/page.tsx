import { resolveRoomIdByCode, verifyRoomAccess } from "@/lib/dal";
import { SolveScreen } from "@/components/solve-screen";

// Epic 03 — the solve screen, addressed by the room's short invite_code
// in the URL (see docs/SCHEMA.md — the room-centric-rounds design) but
// resolved to the real internal room id immediately, once, here — that
// internal id is what flows into SolveScreen and every API call it
// makes, never the code itself, so nothing downstream needs to care
// which identifier the URL used.
export default async function SolveProblemPage({
  params,
}: {
  params: Promise<{ code: string; slug: string }>;
}) {
  const { code, slug } = await params;
  const roomId = await resolveRoomIdByCode(code);
  await verifyRoomAccess(roomId);

  return <SolveScreen roomId={roomId} slug={slug} />;
}
