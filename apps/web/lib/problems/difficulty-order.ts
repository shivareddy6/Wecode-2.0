// The one place round-problem difficulty ordering (easy → medium → hard)
// is defined — the solve workspace's tabs and the leaderboard's Q1/Q2/...
// columns both need the exact same order, and both get it by sorting a
// room's current_problems with this, once, server-side, rather than each
// re-deriving/sorting their own copy independently.
const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

export function sortByDifficulty<T extends { difficulty: string }>(problems: readonly T[]): T[] {
  return [...problems].sort((a, b) => DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty]);
}
