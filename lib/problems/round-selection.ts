import { PROBLEM_CATALOG, type CatalogEntry, type Difficulty } from "@/lib/problems/catalog";

// Epic 05, Story 1 — the four presets and their difficulty counts are
// given verbatim in the epic's acceptance criteria, not invented here.
// All four total 4 problems per round.
export const ROUND_PRESETS = {
  warm_up: { label: "Warm-up", description: "3 Easy, 1 Medium", counts: { easy: 3, medium: 1, hard: 0 } },
  balanced: { label: "Balanced", description: "2 Easy, 2 Medium", counts: { easy: 2, medium: 2, hard: 0 } },
  challenge: {
    label: "Challenge",
    description: "1 Easy, 2 Medium, 1 Hard",
    counts: { easy: 1, medium: 2, hard: 1 },
  },
  gauntlet: { label: "Gauntlet", description: "1 Easy, 1 Medium, 2 Hard", counts: { easy: 1, medium: 1, hard: 2 } },
} as const satisfies Record<string, { label: string; description: string; counts: Record<Difficulty, number> }>;

export type RoundPreset = keyof typeof ROUND_PRESETS;

export function isRoundPreset(value: string): value is RoundPreset {
  return value in ROUND_PRESETS;
}

// Fisher-Yates, not a sort-by-random-comparator — the latter is a known
// biased shuffle.
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export type SelectionResult =
  | { ok: true; problems: CatalogEntry[] }
  | { ok: false; error: string };

// Epic 05, Story 2 — random selection matching the preset's difficulty
// counts, filtered against every slug this room has already run
// (rooms.used_leetcode_slugs — permanent, not just the current round).
// Real enforcement of "never repeat" still lives in start_room_round()'s
// own check; this is what lets selection actually find problems the RPC
// won't reject, and gives a clear error instead of a random anti-repeat
// exception when the catalog's remaining pool for a difficulty runs dry.
export function selectRoundProblems(preset: RoundPreset, usedSlugs: readonly string[]): SelectionResult {
  const used = new Set(usedSlugs);
  const picked: CatalogEntry[] = [];

  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const count = ROUND_PRESETS[preset].counts[difficulty];
    if (count === 0) continue;

    const pool = shuffle(PROBLEM_CATALOG.filter((entry) => entry.difficulty === difficulty && !used.has(entry.slug)));

    if (pool.length < count) {
      return {
        ok: false,
        error: `Not enough unused ${difficulty} problems left in the catalog for the ${ROUND_PRESETS[preset].label} preset.`,
      };
    }

    picked.push(...pool.slice(0, count));
  }

  return { ok: true, problems: picked };
}
