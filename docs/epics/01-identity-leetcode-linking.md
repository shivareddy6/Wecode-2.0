# Epic 01 — Identity & LeetCode Linking

**Goal:** Syncing a LeetCode session is the entire signup and login flow. No separate auth provider, no password. See `ARCHITECTURE.md` for the full reasoning.

**Why it matters:** Every other epic depends on this — rooms, sessions, chat, and the leaderboard all assume a logged-in WeCode user whose identity is a real LeetCode account.

---

### Story 1 — Sync creates an account
As a new user, I want clicking "Sync" in the extension to both create my WeCode account and log me in, so I don't need a separate signup step.

- Acceptance criteria:
  - A sync request with no matching existing account creates a new user row keyed by LeetCode's numeric user ID.
  - Display name and avatar are populated from LeetCode's public profile data at creation time.
  - The user lands on the app already authenticated (no separate login prompt afterward).

### Story 2 — Sync logs in an existing account
As a returning user, I want re-syncing to log me into my existing account, so my rooms/history aren't lost or duplicated.

- Acceptance criteria:
  - Lookup by LeetCode numeric user ID happens before any create step.
  - An existing user's stored session credential is refreshed with the new value; no duplicate account is created.

### Story 3 — Stale session detection
As a user, I want the app to detect when my synced LeetCode session has expired, so I know to resync before trying to submit again.

- Acceptance criteria:
  - When a submission-proxy call fails with a LeetCode auth-rejection signal, the stored session is marked invalid.
  - The UI shows a clear "Reconnect LeetCode" prompt in place of the solve screen, without logging the user out of WeCode itself.
  - Chat, rooms, and leaderboard viewing remain available with a stale LeetCode session — only submitting is blocked.

### Story 4 — Encrypted credential storage
As a user, I want my LeetCode session credentials encrypted at rest, so a database compromise doesn't expose my LeetCode account.

- Acceptance criteria:
  - The stored session cookie value and CSRF token are ciphertext in the database, never plaintext.
  - The encryption key lives in a server-side secret, never sent to the client.
  - Decryption happens only inside the submission-proxy Route Handler, at the moment it's needed.

### Story 5 — Manual credential entry
As a user, I want to sync my LeetCode account by manually pasting my session token and CSRF token, so I can use WeCode without installing the browser extension.

- Acceptance criteria:
  - A form accepts both values and posts them to the same sync endpoint the extension uses — no separate code path or account type.
  - Basic format validation catches obviously-wrong pastes (empty, truncated) before hitting LeetCode.
  - Field labels/help text point the user at where in their browser to find these values, since this is a manual, technical step for anyone not using the extension.
  - A user who synced manually can later resync via the extension (or vice versa) — the two methods are interchangeable for the same account, keyed by the same LeetCode numeric user ID.

### Story 6 — Supabase Auth bridging
As the system, I want a real Supabase Auth session provisioned per LeetCode-linked account, so existing Row Level Security policies keyed on `auth.uid()` keep working without a bespoke session system.

- Acceptance criteria:
  - A Supabase Auth user is created (via the admin API) or reused per LeetCode numeric ID.
  - The sync flow completes by issuing a standard Supabase session cookie.
  - No separate JWT/session library is introduced.

### Story 7 — Centralized session verification (Data Access Layer)
As the system, I want a single, centralized `verifySession()` function that every Server Component, Server Action, and Route Handler calls to check who's making a request, so authorization checks can't be forgotten in one spot while present everywhere else.

- Acceptance criteria:
  - `lib/dal.ts` exports `verifySession()`, calling `supabase.auth.getUser()` (never `getSession()`, which only reads the local cookie without revalidating it against Supabase's Auth server) and memoized per request with React's `cache()`.
  - `verifySession()` redirects to the sync/login flow (or calls Next's `unauthorized()`) when there's no valid user — callers don't each implement their own fallback.
  - A `getCurrentUser()` built on top of it returns only the fields safe to hand to the rest of the app (name, avatar, LeetCode link status) through a DTO — never the encrypted LeetCode credential columns, even incidentally.
  - Every Server Action and Route Handler in the app calls `verifySession()` (or a room-scoped wrapper such as `verifyRoomAccess(roomId)`) as its first line, treated as a public-facing endpoint regardless of whether the calling UI already hides the action from unauthorized users.
  - Any code path using Supabase's service-role key (admin-provisioning a Supabase Auth user during sync; the submission-proxy's credential lookup) has an explicit ownership check in the DAL — these paths bypass Row Level Security entirely, so the DAL check is their only safeguard, not a backup to one.
