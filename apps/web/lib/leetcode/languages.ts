// The launch language set (Epic 03, Story 4) — mirrors the `language`
// check constraint on public.submissions exactly, so this is the one place
// that enum needs to be kept in sync with the schema.
export const SUPPORTED_LANGUAGES = [
  "python3",
  "java",
  "cpp",
  "javascript",
  "go",
  "c",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

// LeetCode's own langSlug values don't all match our enum — most notably
// Go is "golang" on LeetCode, not "go". This is the one place that
// translation happens, both to pick the right starter-code snippet out of
// LeetCode's response and to pass the right slug to LeetCode's submit call.
export const LEETCODE_LANG_SLUG: Record<SupportedLanguage, string> = {
  python3: "python3",
  java: "java",
  cpp: "cpp",
  javascript: "javascript",
  go: "golang",
  c: "c",
};
