# Epic 05 — Sessions (Contests)

**Goal:** A session is a timed, multi-problem contest run inside a room. A room can run many sessions back-to-back; each is independent (fresh problems, fresh timer, fresh leaderboard — see Epic 06).

---

### Story 1 — Start a session with a difficulty preset
As a host, I want to start a new session by picking a difficulty preset and a duration, so a fresh contest begins for everyone in the room.

- Acceptance criteria:
  - The host chooses one of four presets: Warm-up (3 Easy/1 Medium), Balanced (2 Easy/2 Medium), Challenge (1 Easy/2 Medium/1 Hard), Gauntlet (1 Easy/1 Medium/2 Hard).
  - The host sets a session duration.
  - Starting a session immediately begins the countdown for all participants.

**Status: Done.** `ROUND_PRESETS` (`lib/problems/round-selection.ts`) defines the four presets verbatim from the AC; the room page's host form (`app/rooms/[code]/page.tsx`) has a preset `<select>` and a duration-in-minutes `<input>` (clamped 5–180 in `startRound`, `app/rooms/actions.ts`). `start_room_round()` writes `round_started_at = now()` for everyone the moment it commits.

### Story 2 — Random problem selection
As the system, I want to randomly select problems matching the chosen preset's difficulty counts when a session starts, so problem choice is fair and unpredictable.

- Acceptance criteria:
  - The selected problems are fixed for the session's duration (not re-rolled mid-session).
  - Selection avoids repeating a problem already used earlier in the same room, where enough unused problems matching the preset exist.

**Status: Done.** `selectRoundProblems()` (`lib/problems/round-selection.ts`) Fisher-Yates shuffles each difficulty's unused pool (filtered against `rooms.used_leetcode_slugs`) and takes the preset's count; `start_room_round()` still re-enforces anti-repeat as the actual source of truth. When a difficulty's pool doesn't have enough unused entries left — the AC's own "where enough exist" escape hatch — `startRound` throws a clear error naming the preset and difficulty, rather than silently reusing a problem. Still a curated static catalog (`lib/problems/catalog.ts`, 28 real LeetCode slugs), not live browsing of LeetCode's actual problem set — a disclosed scope limit, not a placeholder.

### Story 3 — Live countdown
As a participant, I want to see how much time is left in the current session, so I know how long I have.

- Acceptance criteria:
  - A countdown is visible throughout the session, synced closely enough across participants that "time's up" lands at effectively the same moment for everyone.

**Status: Done, with a caveat.** `RoundCountdown` (`components/round-countdown.tsx`) is client-computed from the shared `round_started_at`/`round_duration_seconds` already on the room row — no Epic 11/socket push needed, since every viewer's clock independently lands on the same deadline instant from the same server-authoritative timestamp. Shown on both the room page and the solve screen. The caveat: this assumes each viewer's own clock is roughly correct — a minor, accepted compromise on "synced," not literal server-authoritative ticking, to avoid pulling in Epic 11 for this alone.

Two bugs found and fixed after initial testing with a second real account: (1) a hydration mismatch — the countdown seeded its "now" state with `Date.now()` directly, sampled once during SSR and again a few milliseconds later during client hydration, which can disagree on which second it is. First fix attempt used `useSyncExternalStore` to represent the clock value itself, which is wrong — the hook requires `getSnapshot()` to return a *stable* value between subscriber notifications, and `Date.now()` changes on every call by definition, which React's own runtime correctly rejects with an infinite-loop guard ("The result of getSnapshot should be cached"). The actual fix splits the two concerns: `useSyncExternalStore` with two fixed primitives (`true`/`false`) as a "has this mounted on the client yet" gate — the part of the problem it's actually suited for — plus an ordinary `useState`/`useEffect`/`setInterval` for the real ticking value, only consulted once mounted. (2) See Story 6's status for the "other participants don't see an early end" bug this same component now also fixes.

### Story 4 — Solve problems in any order
As a participant, I want to move between the session's problems freely and submit to any of them before time runs out, so I can attempt them in whatever order I prefer.

- Acceptance criteria:
  - All of a session's problems are accessible to a participant simultaneously, each backed by the Solo Solve experience (Epic 03).

**Status: Done, no new code needed.** `current_problems` was already an array and `app/api/rooms/[roomId]/problems/[slug]/route.ts` already validated a slug's membership in it, independent of how many entries it holds. Now that Story 1/2 actually produce multiple problems per round, the room page's existing per-problem links (`app/rooms/[code]/page.tsx`) give simultaneous access to all of them, in any order.

### Story 5 — Automatic session end
As the system, I want a session to end automatically when its timer expires, so results become final without host intervention.

- Acceptance criteria:
  - Submissions whose judging request was made before the deadline are still counted even if the verdict resolves slightly after.
  - **Revised** (was "rejected," changed by explicit product decision on 2026-09-06): submissions initiated after the deadline are still accepted and judged for real by LeetCode, but are flagged `is_out_of_contest` and excluded entirely from the leaderboard — no score, no penalty contribution, regardless of verdict. Wherever a submission is shown (the solve screen now, chat later — Epic 07, Story 5), an out-of-contest one is visibly distinguishable from an in-contest one.
  - Once ended, the session's leaderboard is locked and final standings are computed (Epic 06).

**Status: Partial.** The first two ACs are done: `app/api/submissions/route.ts` computes the deadline directly off `round_started_at`/`round_duration_seconds` (`lib/rounds/deadline.ts`) and, if past it, inserts the submission with `is_out_of_contest = true` instead of rejecting it — `compute_leaderboard()` (migration `20260906100000_out_of_contest_submissions.sql`) excludes any such row entirely, verified against real data (a scratch room's out-of-contest accept contributed 0 to `total_score` and didn't count toward `problems_solved`). The solve screen (`components/solve-screen.tsx`) shows an "Out of contest" badge on the submission result. There's no background job, so nothing pushes the instant the clock hits zero; expiry is detected lazily (room page load, or a submission attempt) and written back via `finalize_expired_round()` so `round_status` converges to `'ended'` for anyone just looking at the room — this is independent of the out-of-contest flag itself, which is decided fresh from timestamps at every submission regardless of what `round_status` currently says. The third AC — locking and computing final standings — is genuinely not done: that's Epic 06 (Leaderboard), which doesn't exist yet, so there's nothing to lock or compute.

### Story 6 — End a session early
As a host, I want to end a session before its timer runs out, so I'm not forced to wait if everyone's already finished.

- Acceptance criteria:
  - Ending early triggers the same finalization behavior as automatic expiry.

**Status: Done.** `endRound` (`app/rooms/actions.ts`) is a host-only Server Action that flips `round_status` to `'ended'` immediately, exposed as an "End round early" button on the room page while a round is active. Same caveat as Story 5's third AC: "finalization" here only means the round_status flip — there's no leaderboard yet to lock.

Bug found and fixed with a second real account testing this: ending early updated the *host's* view instantly (their own `refresh()` after the action), but another participant's already-loaded page had no way to learn `round_status` changed — their countdown kept ticking down toward the original deadline. Fixed in `RoundCountdown` (`components/round-countdown.tsx`) with a `router.refresh()` on a 5-second interval while a round is active, self-terminating once a refresh reports `'ended'`. This is a deliberate polling approximation, not push — "immediately enough" for a friends-group contest without pulling in Epic 11's sockets just for this one signal. If Epic 11 gets built later for chat/live leaderboard anyway, this polling loop is a natural thing to replace with a real push event at that point, not before.

### Story 7 — Start a new session in the same room
As a host, I want to start another session in the same room after one ends, so the group can keep playing without recreating the room.

- Acceptance criteria:
  - Starting a new session while the room remains open resets the countdown and leaderboard and selects a new problem set per Story 1/2.

**Status: Done** (unchanged from the room-centric-rounds pass — `start_room_round()` already handles this atomically), now exercised with real presets/durations/random selection instead of a single hardcoded slug. "Resets the leaderboard" is inherent to the room-centric design (submissions are cleared on every round transition — see `docs/SCHEMA.md`), not something this story adds.
