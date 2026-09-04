import { verifyRoomAccess } from "@/lib/dal";
import { SolveScreen } from "@/components/solve-screen";

// Epic 03 — the solo-solve mechanism, now driven by a real
// session_problem instead of a bare slug (see the room/session pivot).
export default async function SolveProblemPage({
  params,
}: {
  params: Promise<{ roomId: string; sessionProblemId: string }>;
}) {
  const { roomId, sessionProblemId } = await params;
  await verifyRoomAccess(roomId);

  return <SolveScreen sessionProblemId={sessionProblemId} />;
}
