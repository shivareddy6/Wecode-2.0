"use client";

import Link from "next/link";
import { RoundCountdown } from "@/components/round-countdown";
import { ProfileMenu } from "@/components/solve/profile-menu";

export function TopBar({
  code,
  roundStartedAt,
  roundDurationSeconds,
  roundStatus,
  viewerDisplayName,
  viewerLeetcodeUsername,
  viewerAvatarUrl,
  onOpenLeaderboard,
  onToggleSidePanel,
  onShowShortcuts,
}: {
  code: string;
  roundStartedAt: string | null;
  roundDurationSeconds: number | null;
  roundStatus: "active" | "ended" | null;
  viewerDisplayName: string | null;
  viewerLeetcodeUsername: string;
  viewerAvatarUrl: string | null;
  onOpenLeaderboard: () => void;
  onToggleSidePanel: () => void;
  onShowShortcuts: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-panel px-4 py-2">
      <div className="flex items-center gap-3 text-sm">
        <Link href={`/rooms/${code}`} className="text-muted hover:text-foreground">
          ← Room
        </Link>
        <span className="text-muted">·</span>
        <code className="font-mono text-muted">{code}</code>
      </div>

      <RoundCountdown roundStartedAt={roundStartedAt} roundDurationSeconds={roundDurationSeconds} roundStatus={roundStatus} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenLeaderboard}
          title="Leaderboard (⌘⇧L)"
          className="rounded-full border border-border px-3 py-1.5 text-sm font-medium hover:bg-panel-raised"
        >
          Leaderboard
        </button>
        <button
          type="button"
          onClick={onToggleSidePanel}
          title="Toggle chat (⌘B)"
          className="rounded-full border border-border px-3 py-1.5 text-sm font-medium hover:bg-panel-raised"
        >
          Chat
        </button>
        <ProfileMenu
          displayName={viewerDisplayName}
          leetcodeUsername={viewerLeetcodeUsername}
          avatarUrl={viewerAvatarUrl}
          onShowShortcuts={onShowShortcuts}
        />
      </div>
    </div>
  );
}
