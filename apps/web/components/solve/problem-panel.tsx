"use client";

import type { LoadedProblem } from "@/components/solve/editor-panel";
import { CollapsedRail } from "@/components/solve/collapsed-rail";

export type RoundProblem = { slug: string; title: string; difficulty: "easy" | "medium" | "hard" };
export type ProblemStatus = "solved" | "attempted" | "none";

export type ProblemLoadState =
  | { kind: "loading" }
  | { kind: "stale" }
  | { kind: "error"; message: string }
  | { kind: "ready"; problem: LoadedProblem };

export const DIFFICULTY_COLOR: Record<string, string> = {
  easy: "text-success",
  medium: "text-warning",
  hard: "text-danger",
};

// Left panel of the solve workspace: the round's problem tabs (with a
// solved/attempted marker on each, so you can tell what's left without
// opening every tab) plus the full statement for whichever one is active.
export function ProblemPanel({
  problems,
  activeSlug,
  statuses,
  loadStates,
  onSelect,
  collapsed,
  onExpand,
}: {
  problems: RoundProblem[];
  activeSlug: string;
  statuses: Record<string, ProblemStatus>;
  loadStates: Record<string, ProblemLoadState>;
  onSelect: (slug: string) => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const activeState = loadStates[activeSlug];

  if (collapsed) {
    return <CollapsedRail label="Description" onExpand={onExpand} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-border p-2">
        {problems.map((problem, index) => {
          const status = statuses[problem.slug] ?? "none";
          const isActive = problem.slug === activeSlug;
          return (
            <button
              key={problem.slug}
              type="button"
              onClick={() => onSelect(problem.slug)}
              title={problem.title}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${
                isActive ? "bg-panel-raised" : "hover:bg-panel-raised"
              }`}
            >
              <StatusDot status={status} />
              <span className={DIFFICULTY_COLOR[problem.difficulty]}>Q{index + 1}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!activeState || activeState.kind === "loading" ? (
          <p className="text-sm text-muted">Loading problem…</p>
        ) : activeState.kind === "stale" ? (
          <p className="text-sm text-muted">
            Your LeetCode session has expired — reconnect from the home page.
          </p>
        ) : activeState.kind === "error" ? (
          <p className="text-sm text-danger">{activeState.message}</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold">{activeState.problem.title}</h1>
            <p className={`mb-4 text-sm font-medium ${DIFFICULTY_COLOR[activeState.problem.difficulty.toLowerCase()] ?? "text-muted"}`}>
              {activeState.problem.difficulty}
            </p>
            {/* LeetCode's own problem HTML, from LeetCode's API — a trusted
                source, not user-generated content. */}
            <div
              className="text-sm leading-relaxed [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-panel-raised [&_pre]:p-3"
              dangerouslySetInnerHTML={{ __html: activeState.problem.content }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ProblemStatus }) {
  if (status === "solved") {
    return <span className="text-success">✓</span>;
  }
  if (status === "attempted") {
    return <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />;
  }
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-border-strong" />;
}
