# Epic 08 — Security & Abuse Prevention

**Goal:** The baseline needed to responsibly run a "semi-public, shareable" app where anyone with a link can create/join rooms and where the app is impersonating users' LeetCode sessions on their behalf.

---

### Story 1 — Encryption at rest
As a user, I want my LeetCode session credentials encrypted at rest. (Owned here, consumed by Identity epic Story 4 — listed once to avoid duplication.)

- Acceptance criteria: see Epic 01, Story 4.

### Story 2 — Submission-proxy rate limiting
As the system, I want per-user and global rate limits on the LeetCode submission-proxy endpoint, so WeCode's aggregate traffic pattern doesn't get flagged as abuse by LeetCode.

- Acceptance criteria: see Epic 03, Story 5 for the user-facing behavior; this story owns the global (cross-user) limiting layer.

**Status: Explicitly descoped 2026-09-25**, by the user's own call when this epic was picked up. The per-user half (Epic 03, Story 5's cooldown + LeetCode-signaled backoff) is done. The global (cross-user) limiting layer this story owns is not being built right now — not worth the complexity at this project's actual scale (a small friends-group tool), and revisit only if real usage ever suggests otherwise.

### Story 3 — Room and participant caps
As the system, I want a cap on concurrently open rooms per host and participants per room, so the link-sharing model can't be used to spin up unbounded load.

- Acceptance criteria:
  - A host cannot exceed a configured number of simultaneously open rooms.
  - A room cannot exceed its configured participant cap (Epic 04, Story 7).
  - Both caps are configuration values, not hardcoded.

**Status: Partial, second half explicitly descoped 2026-09-25.** The per-room participant cap (`rooms.participant_cap`, enforced in `join_room()`) is done — see Epic 04, Story 7. The per-host open-room cap is not being built right now, by the user's own call — same reasoning as Story 2 above.

### Story 4 — Revocable invite links
As a host, I want to revoke or regenerate my room's invite link, so a leaked link doesn't permanently compromise the room.

- Acceptance criteria:
  - Regenerating a room's invite link immediately invalidates the previous one.

**Status: Done.** `regenerateInviteLink` (`apps/web/app/rooms/actions.ts`) is a direct `rooms.invite_code` update under RLS — the same "no new RPC" shape as `endRound`/`closeRoom`/`removeParticipant`/`transferHost`; the pre-existing `"hosts manage their own rooms"` policy's `USING` clause already restricts it to the host, and the `WITH CHECK` widened for `transferHost` only constrains `host_user_id`, which this update never touches. Invalidating the old code needs no explicit "revoke" step: rooms are looked up by `invite_code` directly (`lookupRoomForJoin`/`resolveRoomIdByCode`) and the column is unique, so the moment the new value commits, the old code simply matches no row. Redirects the host to the new code's URL immediately (unlike `endRound`/`closeRoom`'s `refresh()`) since they're sitting on a URL keyed by the code that's about to stop resolving. A "Regenerate invite link" button was added to the room page's host-only controls. Verified via `npm run verify:regenerate-invite-link -w web` (7/7): non-host rejection, the write itself, the old code failing to resolve, the new code resolving to the same room, a newcomer blocked on the old code but able to join via the new one, and existing members left completely unaffected.

### Story 5 — Failure alerting
As the developer, I want basic logging/alerting on submission-proxy failures, so a broken LeetCode integration (e.g. LeetCode changes their API) is caught quickly rather than silently failing for everyone.

- Acceptance criteria:
  - A spike in submission-proxy failures triggers a visible alert/log entry the developer will actually see.

**Status: Done — structured logging only, no external alerting service** (confirmed with the user: no Sentry/Slack webhook is wired into this project, and adding one wasn't wanted right now). `apps/web/lib/monitoring/proxy-failures.ts`'s `recordProxyFailure(context, detail)` logs every individual proxy failure (`console.error`, visible in Vercel's function logs) and additionally fires a louder `ALERT:` line once failures cross a threshold within a rolling window (both env-configurable, default 5 failures / 5 minutes — config values, not hardcoded, matching this project's usual pattern). Wired into the two genuine "integration might be broken" failure points: the submission-proxy route's (`apps/web/app/api/submissions/route.ts`) `LeetCodeUnavailableError` branch and its final generic/unexpected-error catch, and the status-polling route's (`apps/web/app/api/submissions/[id]/status/route.ts`) `checkSubmissionStatus` catch. Deliberately *not* wired into `LeetCodeSessionExpiredError`/`LeetCodeRateLimitError` — both are expected, per-user conditions already surfaced to that user, not a sign the LeetCode integration itself is broken, so counting them would just produce false-positive spikes from normal operation. Tracked in a module-level array, not a table — genuinely per-process/per-instance, which is an accepted limitation on a future multi-instance serverless deploy (a spike spread evenly across instances could go under-detected), but every individual failure is still logged regardless of spike detection, and this project's actual scale doesn't warrant a dedicated table + writes on every failure. Verified via `npm run verify:failure-spike-alert -w web` (4/4, no Supabase dependency — pure in-process logic): every failure logs individually below threshold, no `ALERT` line until the threshold is actually crossed, crossing it fires one with the right count/context, and failures aging out of the rolling window don't count toward a new spike.
