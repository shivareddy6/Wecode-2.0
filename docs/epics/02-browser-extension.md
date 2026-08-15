# Epic 02 — Browser Extension

**Goal:** Capture the user's LeetCode session and hand it to WeCode, distributed as a sideloadable extension pointed at the real deployed app (not localhost, v1's mistake).

---

### Story 1 — Sideloadable build
As a user, I want to install the extension by loading an unpacked build, so I can start using WeCode without waiting on a store review.

- Acceptance criteria:
  - The repo has a build step producing a ready-to-load unpacked extension folder.
  - A short "how to sideload" doc exists (enable developer mode, load unpacked, select the folder).
  - The extension popup displays a version number for debugging/support.

### Story 2 — Points at the real domain
As a user, I want the extension to talk to the deployed WeCode app, not localhost, so sync actually works for anyone, not just the developer's machine.

- Acceptance criteria:
  - The extension's API base URL is a build-time config value defaulting to the production domain.
  - A separate dev build variant can point at localhost for local development.

### Story 3 — One-click sync
As a user, I want a single "Sync" button that grabs my current LeetCode session and sends it to WeCode, so connecting my account takes one click.

- Acceptance criteria:
  - The popup shows connection status: Not connected / Connected as `<username>` / Needs resync.
  - Clicking Sync reads the LeetCode session cookie from the browser, posts it to the sync Route Handler, and updates the popup to reflect the result.

### Story 4 — Not logged into LeetCode at all
As a user, I want a clear message when I'm not logged into leetcode.com at all, so I know to log in there first before syncing.

- Acceptance criteria:
  - A sync attempt with no LeetCode session cookie present shows an explicit "You're not logged into LeetCode" message, distinct from other sync failures.
