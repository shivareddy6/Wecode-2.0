"use client";

// A collapsed panel's rail — a narrow, fixed-width strip with a vertical
// label instead of the panel vanishing to zero width. Click to re-expand;
// dragging the panel group's resize handle past the collapse threshold
// re-expands it too (react-resizable-panels' own behavior, nothing extra
// needed here for that path).
export function CollapsedRail({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Expand ${label}`}
      className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted hover:text-foreground"
    >
      <span className="text-xs" style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}>
        {label}
      </span>
    </button>
  );
}
