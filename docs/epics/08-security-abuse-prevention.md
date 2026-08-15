# Epic 08 — Security & Abuse Prevention

**Goal:** The baseline needed to responsibly run a "semi-public, shareable" app where anyone with a link can create/join rooms and where the app is impersonating users' LeetCode sessions on their behalf.

---

### Story 1 — Encryption at rest
As a user, I want my LeetCode session credentials encrypted at rest. (Owned here, consumed by Identity epic Story 4 — listed once to avoid duplication.)

- Acceptance criteria: see Epic 01, Story 4.

### Story 2 — Submission-proxy rate limiting
As the system, I want per-user and global rate limits on the LeetCode submission-proxy endpoint, so WeCode's aggregate traffic pattern doesn't get flagged as abuse by LeetCode.

- Acceptance criteria: see Epic 03, Story 5 for the user-facing behavior; this story owns the global (cross-user) limiting layer.

### Story 3 — Room and participant caps
As the system, I want a cap on concurrently open rooms per host and participants per room, so the link-sharing model can't be used to spin up unbounded load.

- Acceptance criteria:
  - A host cannot exceed a configured number of simultaneously open rooms.
  - A room cannot exceed its configured participant cap (Epic 04, Story 7).
  - Both caps are configuration values, not hardcoded.

### Story 4 — Revocable invite links
As a host, I want to revoke or regenerate my room's invite link, so a leaked link doesn't permanently compromise the room.

- Acceptance criteria:
  - Regenerating a room's invite link immediately invalidates the previous one.

### Story 5 — Failure alerting
As the developer, I want basic logging/alerting on submission-proxy failures, so a broken LeetCode integration (e.g. LeetCode changes their API) is caught quickly rather than silently failing for everyone.

- Acceptance criteria:
  - A spike in submission-proxy failures triggers a visible alert/log entry the developer will actually see.
