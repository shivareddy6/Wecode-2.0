// A small hardcoded pool, standing in for real problem browsing/random
// selection (Epic 05, Story 2) until that gets its own pass. Starting a
// session picks one of these by slug — difficulty here matches
// submissions' check constraint (lowercase).
export const PROBLEM_CATALOG = [
  { slug: "two-sum", title: "Two Sum", difficulty: "easy" as const },
  { slug: "valid-parentheses", title: "Valid Parentheses", difficulty: "easy" as const },
  { slug: "merge-two-sorted-lists", title: "Merge Two Sorted Lists", difficulty: "easy" as const },
  { slug: "add-two-numbers", title: "Add Two Numbers", difficulty: "medium" as const },
  {
    slug: "longest-substring-without-repeating-characters",
    title: "Longest Substring Without Repeating Characters",
    difficulty: "medium" as const,
  },
  { slug: "median-of-two-sorted-arrays", title: "Median of Two Sorted Arrays", difficulty: "hard" as const },
];

export type CatalogEntry = (typeof PROBLEM_CATALOG)[number];

export function findCatalogEntry(slug: string): CatalogEntry | undefined {
  return PROBLEM_CATALOG.find((entry) => entry.slug === slug);
}
