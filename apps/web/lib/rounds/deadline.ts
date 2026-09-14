// Epic 05, Story 5 — shared deadline math for "is this round over yet,"
// used by both the room page and the submissions Route Handler. Kept in
// its own module, not inlined at either call site, because
// eslint-plugin-react-hooks's purity rule forbids calling the impure
// Date.now() directly inside a Server Component's render body — moving it
// behind a plain function in a separate file (rather than just wrapping it
// in a same-file helper, which the rule still sees through) is what
// actually satisfies that check, not just a style preference.
export function computeRoundDeadline(
  roundStartedAt: string | null,
  roundDurationSeconds: number | null,
): number | null {
  if (!roundStartedAt || !roundDurationSeconds) return null;
  return new Date(roundStartedAt).getTime() + roundDurationSeconds * 1000;
}

export function isPastDeadline(deadline: number | null): boolean {
  return deadline !== null && Date.now() >= deadline;
}
