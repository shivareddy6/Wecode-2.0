export type BreakdownRow = {
  user_id: string;
  problem_slug: string;
  problem_title: string;
  difficulty: string;
  status: "solved" | "solved_out_of_contest" | "not_attempted";
  problem_score: number;
  attempt_count: number;
};

function statusLabel(row: BreakdownRow): string {
  if (row.status === "solved") return "Solved";
  if (row.status === "solved_out_of_contest") return "Solved (out of contest)";
  return row.attempt_count === 0 ? "Not attempted" : "Attempted";
}

// Epic 06, Story 4 — the per-problem detail underneath the roster-level
// compute_leaderboard() rollup, from compute_leaderboard_breakdown(). Not
// live-pushed like <LiveLeaderboard> — this is meant to be read after a
// round ends as much as during it, and re-renders on the page's own
// server-render cycle, same as the rest of the room page.
export function ProblemBreakdown({
  rows,
  participantOrder,
  displayNames,
}: {
  rows: BreakdownRow[];
  participantOrder: string[];
  displayNames: Record<string, string | null>;
}) {
  if (rows.length === 0) {
    return null;
  }

  const byUser = new Map<string, BreakdownRow[]>();
  for (const row of rows) {
    const existing = byUser.get(row.user_id);
    if (existing) {
      existing.push(row);
    } else {
      byUser.set(row.user_id, [row]);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold">Per-problem breakdown</h2>
      {participantOrder.map((userId) => {
        const problemRows = byUser.get(userId);
        if (!problemRows) return null;

        return (
          <div key={userId} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {displayNames[userId] ?? "Anonymous"}
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15">
                  <th className="py-2 pr-2">Problem</th>
                  <th className="py-2 pr-2">Difficulty</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2 pr-2 text-right">Score</th>
                  <th className="py-2 text-right">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {problemRows.map((row) => (
                  <tr
                    key={row.problem_slug}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="py-2 pr-2">{row.problem_title}</td>
                    <td className="py-2 pr-2 capitalize">{row.difficulty}</td>
                    <td className="py-2 pr-2">{statusLabel(row)}</td>
                    <td className="py-2 pr-2 text-right font-mono">
                      {row.problem_score}
                    </td>
                    <td className="py-2 text-right">{row.attempt_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
