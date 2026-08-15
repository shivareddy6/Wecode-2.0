# Epic 03 — Solo Solve Experience

**Goal:** The core mechanic, carried over from v1 and hardened: a real LeetCode problem, an in-app editor, and a submission that's genuinely judged by LeetCode. This is the building block every session round is made of.

---

### Story 1 — Real problem content
As a user, I want to open a problem and see its real LeetCode description, so I don't have to leave the app to read the prompt.

- Acceptance criteria:
  - Problem statement, examples, and constraints are fetched from LeetCode and rendered in-app.

### Story 2 — Real judging
As a user, I want my submitted code to be genuinely graded by LeetCode, so my result is a real Accepted/Wrong Answer, not a reimplementation.

- Acceptance criteria:
  - Submissions are proxied to LeetCode using the user's synced session.
  - The app polls for a verdict and displays it (Accepted / Wrong Answer / etc.) along with pass/fail test counts, once resolved.

### Story 3 — Judging status feedback
As a user, I want to see a live "Judging..." state while my submission is being graded, so I know the app hasn't frozen.

- Acceptance criteria:
  - The UI shows a distinct in-progress state between submit and verdict, driven by the polling loop.

### Story 4 — Language selection
As a user, I want to choose my preferred coding language when solving a problem, so I can code in the language I'm most comfortable with.

- Acceptance criteria:
  - A language selector offers the launch language set (Python3, Java, C++, JavaScript, Go, C).
  - Selecting a language loads that language's starter code from LeetCode for the current problem.
  - Submission passes the selected language through to LeetCode's own submit call.

### Story 5 — Submission rate limiting
As the system, I want submission attempts rate-limited sensibly, so WeCode's aggregate traffic doesn't get flagged or blocked by LeetCode.

- Acceptance criteria:
  - A per-user cooldown applies between submissions on the same problem.
  - A backoff/retry path exists for when LeetCode responds with a rate-limit signal.

### Story 6 — Expired session mid-solve
As a user, I want a clear error when my synced session has expired while I'm solving, so I know to resync rather than seeing a confusing failure.

- Acceptance criteria:
  - Same detection/prompt behavior as Identity epic Story 3, surfaced directly on the solve screen.
