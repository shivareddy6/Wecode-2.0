"use client";

import { ParticipantList, type ParticipantRow } from "@/components/participant-list";
import { Chat, type ChatMessageRow } from "@/components/chat";
import { CollapsedRail } from "@/components/solve/collapsed-rail";

// Right panel of the solve workspace: participants + chat, always
// reachable while solving — the "solving is a dead end" gap the pre-revamp
// UI had, where you could only see either one from the room page.
export function SidePanel({
  roomId,
  initialParticipants,
  initialChatMessages,
  isHost,
  viewerId,
  hostUserId,
  collapsed,
  onExpand,
}: {
  roomId: string;
  initialParticipants: ParticipantRow[];
  initialChatMessages: ChatMessageRow[];
  isHost: boolean;
  viewerId: string;
  hostUserId: string;
  collapsed: boolean;
  onExpand: () => void;
}) {
  if (collapsed) {
    return <CollapsedRail label="Chat" onExpand={onExpand} />;
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-3">
      <div className="max-h-40 shrink-0 overflow-y-auto">
        <ParticipantList
          roomId={roomId}
          initialParticipants={initialParticipants}
          isHost={isHost}
          viewerId={viewerId}
          hostUserId={hostUserId}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border pt-3">
        <Chat roomId={roomId} initialMessages={initialChatMessages} isHost={isHost} viewerId={viewerId} listClassName="min-h-0 flex-1" />
      </div>
    </div>
  );
}
