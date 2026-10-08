"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { createClient } from "@/lib/supabase/client";
import { TopBar } from "@/components/solve/top-bar";
import {
  ProblemPanel,
  type ProblemLoadState,
  type ProblemStatus,
  type RoundProblem,
} from "@/components/solve/problem-panel";
import { EditorPanel, type LoadedProblem } from "@/components/solve/editor-panel";
import { SidePanel } from "@/components/solve/side-panel";
import { LeaderboardPopup } from "@/components/solve/leaderboard-popup";
import { ShortcutsDialog } from "@/components/solve/shortcuts-dialog";
import type { ParticipantRow } from "@/components/participant-list";
import type { ChatMessageRow } from "@/components/chat";

const SIDE_PANEL_DEFAULT_SIZE = 22;

export function SolveWorkspace({
  roomId,
  code,
  initialSlug,
  problems,
  roundStartedAt,
  roundDurationSeconds,
  roundStatus,
  viewerId,
  viewerDisplayName,
  viewerLeetcodeUsername,
  viewerAvatarUrl,
  isHost,
  hostUserId,
  initialParticipants,
  initialChatMessages,
}: {
  roomId: string;
  code: string;
  initialSlug: string;
  problems: RoundProblem[];
  roundStartedAt: string | null;
  roundDurationSeconds: number | null;
  roundStatus: "active" | "ended" | null;
  viewerId: string;
  viewerDisplayName: string | null;
  viewerLeetcodeUsername: string;
  viewerAvatarUrl: string | null;
  isHost: boolean;
  hostUserId: string;
  initialParticipants: ParticipantRow[];
  initialChatMessages: ChatMessageRow[];
}) {
  // `problems` arrives already sorted easy-to-hard (SolveProblemPage sorts
  // current_problems server-side via sortByDifficulty) — the leaderboard
  // popup gets the same array below so its Q1/Q2/... columns line up with
  // these tabs by construction, not by coincidence of two sort call sites.
  const [activeSlug, setActiveSlug] = useState(initialSlug);
  const [loadStates, setLoadStates] = useState<Record<string, ProblemLoadState>>({});
  const [statuses, setStatuses] = useState<Record<string, ProblemStatus>>({});
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [problemPanelCollapsed, setProblemPanelCollapsed] = useState(false);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  const problemPanelRef = useRef<ImperativePanelHandle>(null);
  const sidePanelRef = useRef<ImperativePanelHandle>(null);

  function loadProblem(slug: string) {
    // Once a problem has ever loaded successfully, switching back to its
    // tab is a pure display-toggle — no refetch, no re-render of its
    // content, no matter how much time passed in between. Only a slug
    // that's never been fetched (or that errored/went stale) fetches here.
    if (loadStates[slug]?.kind === "ready") return;

    setLoadStates((prev) => {
      if (prev[slug]) return prev;
      return { ...prev, [slug]: { kind: "loading" } };
    });

    fetch(`/api/rooms/${roomId}/problems/${slug}`)
      .then(async (response) => {
        const data = await response.json();

        if (response.status === 401 && data.error === "leetcode_session_stale") {
          setLoadStates((prev) => ({ ...prev, [slug]: { kind: "stale" } }));
          return;
        }
        if (!response.ok) {
          setLoadStates((prev) => ({ ...prev, [slug]: { kind: "error", message: data.error ?? "Couldn't load this problem." } }));
          return;
        }

        setLoadStates((prev) => ({ ...prev, [slug]: { kind: "ready", problem: data as LoadedProblem } }));
      })
      .catch(() => {
        setLoadStates((prev) => ({ ...prev, [slug]: { kind: "error", message: "Couldn't reach WeCode. Check your connection." } }));
      });
  }

  useEffect(() => {
    loadProblem(initialSlug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab status markers: whether the viewer has solved/attempted each of
  // this round's problems, so a glance at the tab strip shows what's left.
  useEffect(() => {
    let cancelled = false;

    async function loadStatuses() {
      const supabase = createClient();
      const { data } = await supabase
        .from("submissions")
        .select("problem_slug, verdict")
        .eq("room_id", roomId)
        .eq("user_id", viewerId);

      if (cancelled || !data) return;

      const next: Record<string, ProblemStatus> = {};
      for (const row of data) {
        const current = next[row.problem_slug];
        if (row.verdict === "accepted") {
          next[row.problem_slug] = "solved";
        } else if (current !== "solved") {
          next[row.problem_slug] = "attempted";
        }
      }
      setStatuses(next);
    }

    void loadStatuses();
    return () => {
      cancelled = true;
    };
  }, [roomId, viewerId]);

  function handleSelect(slug: string) {
    setActiveSlug(slug);
    loadProblem(slug);
    // Shallow-update the URL via the native History API so the tab
    // switch doesn't trigger a Next.js navigation on the [slug] route
    // param — that would re-run the server component and remount this
    // workspace, losing every other tab's already-fetched problem state.
    window.history.replaceState(null, "", `/rooms/${code}/solve/${slug}`);
  }

  function handleSubmissionResolved(slug: string, accepted: boolean) {
    setStatuses((prev) => ({
      ...prev,
      [slug]: accepted ? "solved" : prev[slug] === "solved" ? "solved" : "attempted",
    }));
  }

  function toggleSidePanel() {
    const panel = sidePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.resize(SIDE_PANEL_DEFAULT_SIZE);
    else panel.collapse();
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;

      if (event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setLeaderboardOpen((open) => !open);
      } else if (!event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidePanel();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        code={code}
        roundStartedAt={roundStartedAt}
        roundDurationSeconds={roundDurationSeconds}
        roundStatus={roundStatus}
        viewerDisplayName={viewerDisplayName}
        viewerLeetcodeUsername={viewerLeetcodeUsername}
        viewerAvatarUrl={viewerAvatarUrl}
        onOpenLeaderboard={() => setLeaderboardOpen(true)}
        onToggleSidePanel={toggleSidePanel}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel ref={problemPanelRef} defaultSize={32} minSize={20} collapsedSize={4} collapsible
          onCollapse={() => setProblemPanelCollapsed(true)}
          onExpand={() => setProblemPanelCollapsed(false)}
        >
          <ProblemPanel
            problems={problems}
            activeSlug={activeSlug}
            statuses={statuses}
            loadStates={loadStates}
            onSelect={handleSelect}
            collapsed={problemPanelCollapsed}
            onExpand={() => problemPanelRef.current?.resize(32)}
          />
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        <Panel defaultSize={100 - 32 - SIDE_PANEL_DEFAULT_SIZE} minSize={30}>
          <div className="relative h-full">
            {problems.map((problem) => {
              const state = loadStates[problem.slug];
              if (!state || state.kind !== "ready") {
                return activeSlug === problem.slug ? (
                  <div key={problem.slug} className="flex h-full items-center justify-center text-sm text-muted">
                    {state?.kind === "error" ? state.message : "Loading problem…"}
                  </div>
                ) : null;
              }

              return (
                <EditorPanel
                  key={problem.slug}
                  roomId={roomId}
                  slug={problem.slug}
                  problem={state.problem}
                  isActive={activeSlug === problem.slug}
                  roundStatus={roundStatus}
                  onSubmissionResolved={handleSubmissionResolved}
                  onToggleSidePanel={toggleSidePanel}
                  onOpenLeaderboard={() => setLeaderboardOpen(true)}
                />
              );
            })}
          </div>
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        <Panel
          ref={sidePanelRef}
          defaultSize={SIDE_PANEL_DEFAULT_SIZE}
          minSize={18}
          collapsedSize={4}
          collapsible
          onCollapse={() => setSidePanelCollapsed(true)}
          onExpand={() => setSidePanelCollapsed(false)}
        >
          <SidePanel
            roomId={roomId}
            initialParticipants={initialParticipants}
            initialChatMessages={initialChatMessages}
            isHost={isHost}
            viewerId={viewerId}
            hostUserId={hostUserId}
            collapsed={sidePanelCollapsed}
            onExpand={() => sidePanelRef.current?.resize(SIDE_PANEL_DEFAULT_SIZE)}
          />
        </Panel>
      </PanelGroup>

      <LeaderboardPopup roomId={roomId} problems={problems} open={leaderboardOpen} onOpenChange={setLeaderboardOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
