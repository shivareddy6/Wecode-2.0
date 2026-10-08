// Formats a fractional minutes value (as returned by compute_leaderboard /
// compute_leaderboard_breakdown's total_time_minutes / problem_time_minutes)
// as LeetCode-style mm:ss.
export function formatMinutesAsClock(minutes: number): string {
  const totalSeconds = Math.max(0, Math.round(minutes * 60));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}
