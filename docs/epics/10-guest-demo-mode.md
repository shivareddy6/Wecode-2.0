# Epic 10 — Guest / Demo Mode

**Goal:** Let someone with no WeCode account and no synced LeetCode session try the editor and get a real graded result, so they can evaluate WeCode before committing to syncing their own account. Standalone — not tied to any real room, and doesn't affect any real leaderboard.

**Key idea:** submissions are proxied through a single shared "house" LeetCode account (maintained by the developer, synced like any real user), against a small fixed pool of problems. This reuses the exact same submission-proxy machinery as Epic 03 — no separate judge is built for this.

---

### Story 1 — Open the sandbox with no account
As a visitor, I want to open a demo sandbox without creating an account, so I can see how the editor and problem-solving flow feel before committing to anything.

- Acceptance criteria:
  - A `/demo`-style route is reachable with no login and no LeetCode sync.
  - The sandbox is visually/structurally similar to the real solve experience, clearly labeled as a demo.

### Story 2 — Fixed demo problem pool
As a visitor, I want to pick from a small set of demo problems, so I get a representative taste without needing access to the full catalog.

- Acceptance criteria:
  - The demo problem pool is a small, fixed, curated list (configurable, not the full LeetCode catalog).

### Story 3 — Real grading via the house account
As a visitor, I want my demo submission to get a real Accepted/Wrong Answer verdict, so the demo actually shows what WeCode does rather than faking it.

- Acceptance criteria:
  - Demo submissions are proxied through the house account's synced LeetCode session, using the same submission-proxy Route Handler as real users.
  - The house account's credentials are stored and encrypted exactly like any user's (Epic 01, Story 4) — no separate storage path.

### Story 4 — Heavier rate limiting for demo traffic
As the system, I want demo-mode submissions rate-limited more aggressively than normal user traffic, so the shared house account isn't at elevated risk of being flagged by LeetCode.

- Acceptance criteria:
  - Demo submission rate limits are configured independently from, and tighter than, normal per-user limits (Epic 03, Story 5 / Epic 08, Story 2).

### Story 5 — Graceful degradation when the house account's session is stale
As a visitor, I want a sensible fallback if demo grading is temporarily unavailable, so I still get some value from the sandbox rather than a broken error.

- Acceptance criteria:
  - If the house account's session is invalid, the demo shows problems/editor in a read-only or "grading temporarily unavailable" state rather than erroring out, and the rest of the app is unaffected.
  - The developer can resync the house account's session the same way any user would (Epic 01/02), without a special admin flow.

### Story 6 — Convert to a real account
As a visitor who liked the demo, I want a clear path to sync my own LeetCode account, so moving from trying WeCode to actually using it is a natural next step.

- Acceptance criteria:
  - The demo sandbox surfaces a persistent call-to-action to sync a real account (extension or manual paste, Epic 01) at all times, not just on completion.
