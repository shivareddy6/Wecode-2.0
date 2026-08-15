# Epic 09 — Deployment & Ops

**Goal:** Get WeCode actually running somewhere friends can reach, with enough operational hygiene that it doesn't silently break.

---

### Story 1 — Deployed and reachable
As the developer, I want the app deployed on Vercel with environment-specific configuration, so it's usable by friends outside localhost.

- Acceptance criteria:
  - Production environment variables (Supabase project keys, encryption secret, production domain, socket server URL) are configured in Vercel, not committed to the repo.
  - The deployed app is reachable at a stable domain that the browser extension is configured to target (Epic 02, Story 2).

### Story 2 — Versioned database schema
As the developer, I want the Supabase schema and RLS policies captured as version-controlled migrations, so the database can be reproduced and reviewed like code.

- Acceptance criteria:
  - Schema changes ship as migration files in the repo, not manual dashboard edits.

### Story 3 — Consistent extension/domain configuration
As the developer, I want the extension's API base URL and the web app's domain to be documented and consistent, so onboarding a new friend doesn't require tribal knowledge.

- Acceptance criteria:
  - A short setup doc covers: production domain, where to get the sideloadable extension build, and the install steps.

### Story 4 — Basic monitoring
As the developer, I want basic uptime/error monitoring, so outages or broken flows are caught before friends report them in chat.

- Acceptance criteria:
  - Server-side errors (failed submissions, failed syncs, socket server disconnects) are logged somewhere the developer can review.

### Story 5 — Deploy and configure the socket.io service
As the developer, I want the socket.io server deployed as its own service, with its URL known to the Next.js app, so real-time features work in production the same way they do locally.

- Acceptance criteria:
  - The socket.io server deploys independently to Fly.io or Railway, separate from the Vercel deployment of the Next.js app.
  - The Next.js app's socket-server URL is an environment variable, not hardcoded, so it can differ between local development and production (mirroring the extension's API-base-URL pattern in Epic 02, Story 2).
  - A redeploy of either service doesn't require a matching manual redeploy of the other.
