import { verifyRoomAccess } from "@/lib/dal";
import { SolveScreen } from "@/components/solve-screen";

// Epic 03 — the solve screen, addressed by room + slug directly now (see
// docs/SCHEMA.md — the room-centric-rounds design). No sessionId in the
// path: a room has exactly one current round, so roomId + slug is already
// the full, minimal identity a problem instance needs.
export default async function SolveProblemPage({
  params,
}: {
  params: Promise<{ roomId: string; slug: string }>;
}) {
  const { roomId, slug } = await params;
  await verifyRoomAccess(roomId);

  return <SolveScreen roomId={roomId} slug={slug} />;
}
