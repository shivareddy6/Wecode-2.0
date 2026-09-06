// A curated, static pool standing in for real LeetCode problem-set
// browsing — Epic 05, Story 2's actual random-selection logic (see
// round-selection.ts) draws from this list by difficulty, but the list
// itself is still hand-picked slugs, not a live query against LeetCode's
// problem set. Sized (10 easy / 10 medium / 8 hard) so every preset in
// round-selection.ts can run several rounds in a room before genuinely
// exhausting a difficulty's unused pool. difficulty is lowercase to match
// submissions' check constraint.
export const PROBLEM_CATALOG = [
  { slug: "two-sum", title: "Two Sum", difficulty: "easy" as const },
  { slug: "valid-parentheses", title: "Valid Parentheses", difficulty: "easy" as const },
  { slug: "merge-two-sorted-lists", title: "Merge Two Sorted Lists", difficulty: "easy" as const },
  { slug: "best-time-to-buy-and-sell-stock", title: "Best Time to Buy and Sell Stock", difficulty: "easy" as const },
  { slug: "maximum-subarray", title: "Maximum Subarray", difficulty: "easy" as const },
  { slug: "climbing-stairs", title: "Climbing Stairs", difficulty: "easy" as const },
  { slug: "valid-anagram", title: "Valid Anagram", difficulty: "easy" as const },
  { slug: "contains-duplicate", title: "Contains Duplicate", difficulty: "easy" as const },
  { slug: "invert-binary-tree", title: "Invert Binary Tree", difficulty: "easy" as const },
  { slug: "palindrome-number", title: "Palindrome Number", difficulty: "easy" as const },

  { slug: "add-two-numbers", title: "Add Two Numbers", difficulty: "medium" as const },
  {
    slug: "longest-substring-without-repeating-characters",
    title: "Longest Substring Without Repeating Characters",
    difficulty: "medium" as const,
  },
  { slug: "container-with-most-water", title: "Container With Most Water", difficulty: "medium" as const },
  { slug: "3sum", title: "3Sum", difficulty: "medium" as const },
  { slug: "group-anagrams", title: "Group Anagrams", difficulty: "medium" as const },
  { slug: "product-of-array-except-self", title: "Product of Array Except Self", difficulty: "medium" as const },
  { slug: "top-k-frequent-elements", title: "Top K Frequent Elements", difficulty: "medium" as const },
  { slug: "longest-palindromic-substring", title: "Longest Palindromic Substring", difficulty: "medium" as const },
  { slug: "coin-change", title: "Coin Change", difficulty: "medium" as const },
  {
    slug: "kth-largest-element-in-an-array",
    title: "Kth Largest Element in an Array",
    difficulty: "medium" as const,
  },

  { slug: "median-of-two-sorted-arrays", title: "Median of Two Sorted Arrays", difficulty: "hard" as const },
  { slug: "trapping-rain-water", title: "Trapping Rain Water", difficulty: "hard" as const },
  { slug: "longest-valid-parentheses", title: "Longest Valid Parentheses", difficulty: "hard" as const },
  { slug: "merge-k-sorted-lists", title: "Merge k Sorted Lists", difficulty: "hard" as const },
  { slug: "largest-rectangle-in-histogram", title: "Largest Rectangle in Histogram", difficulty: "hard" as const },
  { slug: "word-ladder", title: "Word Ladder", difficulty: "hard" as const },
  { slug: "regular-expression-matching", title: "Regular Expression Matching", difficulty: "hard" as const },
  { slug: "n-queens", title: "N-Queens", difficulty: "hard" as const },
];

export type CatalogEntry = (typeof PROBLEM_CATALOG)[number];
export type Difficulty = CatalogEntry["difficulty"];
