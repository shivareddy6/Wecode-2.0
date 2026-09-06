# WeCode v2 — Documentation Index

WeCode turns solo LeetCode practice into a social, competitive activity: create a room, invite friends, run timed contests together against real LeetCode problems (graded by LeetCode itself, not a reimplementation), chat while solving, and watch a live leaderboard.

This is a from-scratch rebuild informed by a v1 prototype that proved the hardest technical piece (proxying real submissions to LeetCode) but never built the social layer the project was named for. See [`PRD.md`](./PRD.md) for what v1 actually was and what's changing.

## Documents

- [`PRD.md`](./PRD.md) — product requirements: vision, users, functional/non-functional requirements, assumptions, out of scope.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — technical decisions and the reasoning behind them (auth model, database/realtime, Next.js patterns, hosting). Read this if you want the "why," not just the "what."
- `epics/` — one file per epic, each with user stories and acceptance criteria.

## Epics

Status is tracked here at the epic level and inside each epic file at the story level (a "Status:" line under each story's AC) — check the epic file for what specifically is done vs. left within a "Partial" epic.

| # | Epic | Summary | Status |
|---|------|---------|--------|
| 01 | [Identity & LeetCode Linking](./epics/01-identity-leetcode-linking.md) | Syncing a LeetCode session is the entire signup/login flow | Done |
| 02 | [Browser Extension](./epics/02-browser-extension.md) | Captures the LeetCode session, sideloadable, points at prod | Done |
| 03 | [Solo Solve Experience](./epics/03-solo-solve-experience.md) | Real problem, real editor, real LeetCode-graded verdict | Done |
| 04 | [Rooms](./epics/04-rooms.md) | Create/join/close a room, invite links, participants | Partial — Stories 1, 2, 7 done; 3, 4, 5 not started; 6 out of scope |
| 05 | [Sessions (Contests)](./epics/05-sessions-contests.md) | Timed multi-problem rounds inside a room, random problem selection | Partial — Stories 1–4, 6, 7 done; Story 5's leaderboard-lock AC waits on Epic 06 |
| 06 | [Leaderboard & Scoring](./epics/06-leaderboard-scoring.md) | Time + penalty scoring, live updates, resets per session | Partial — `compute_leaderboard()` exists in SQL and excludes out-of-contest submissions (Story 1); unused by any UI yet |
| 07 | [Chat](./epics/07-chat.md) | Real-time in-room text chat | Not started |
| 08 | [Security & Abuse Prevention](./epics/08-security-abuse-prevention.md) | Encryption, rate limits, room/participant caps | Not started beyond the baseline already folded into 01/09/11 |
| 09 | [Deployment & Ops](./epics/09-deployment-ops.md) | Vercel + Supabase, migrations, monitoring | Partial — Supabase project set up and in daily use; no Vercel deploy yet |
| 10 | [Guest / Demo Mode](./epics/10-guest-demo-mode.md) | Zero-signup sandbox graded via a shared house LeetCode account | Not started |
| 11 | [Realtime Server (Socket.io)](./epics/11-realtime-server.md) | Standalone socket.io service carrying chat + live leaderboard, deployed separately from the Next.js app | Not started |

## Suggested build order

This is a suggestion, not a mandate — reorder freely as priorities shift.

1. **Foundations** — 01 (Identity, including manual paste), 02 (Extension), 09 (base Supabase/Vercel setup), 11 (stand up the socket.io service early — both the leaderboard and chat depend on it existing).
2. **Core loop (the actual point of the rebuild)** — 03 (hardened Solo Solve), 04 (Rooms), 05 (Sessions), 06 (Leaderboard, riding on Epic 11 for delivery). Once this ships, the original vision — friends competing on real LeetCode problems with a working leaderboard — exists end to end for the first time.
3. **Social layer** — 07 (Chat). Additive on top of the core loop; shares Epic 11's real-time infrastructure with the leaderboard.
4. **Onboarding/growth** — 10 (Guest/Demo Mode). Reuses the Epic 03 submission-proxy path via a house account; makes sense once that path is proven stable with real users, not before.
5. **Hardening** — 08 (Security & Abuse Prevention beyond the baseline already folded into 01/09/11), tuned against real usage once friends are actually using it.

## Key decisions already made (see ARCHITECTURE.md for full reasoning)

- **Auth:** LeetCode-only. No Google. Syncing your LeetCode session creates your account and logs you in, via either the browser extension or manual credential paste — both supported from day one, both hitting the same sync endpoint.
- **Guest access:** a standalone demo sandbox (no account needed) grades submissions through one shared house LeetCode account against a small fixed problem pool — not a separate custom judge.
- **Database + auth:** Supabase (Postgres + Auth), carried over from v1.
- **Realtime:** a self-hosted socket.io server (Epic 11), deployed separately (Fly.io/Railway) from the Next.js app (Vercel) — carries both chat and the live leaderboard. Chosen over Supabase Realtime for direct control over authorization and one unified event model for persisted and ephemeral events alike, at the cost of an extra deployed service and hand-written room-access checks (see `ARCHITECTURE.md`).
- **Data layer:** Supabase client + generated types directly; no Prisma/Drizzle. Leaderboard math lives in a Postgres view/RPC function.
- **Extension distribution:** sideloaded (unpacked zip), not published to the Chrome Web Store.
- **Room/session model:** a room is an ephemeral container for one hangout; it can run multiple timed, multi-problem sessions back-to-back before being closed; the leaderboard resets at the start of each session (not cumulative across the room).
- **Scoring:** time-decay + wrong-submission-penalty (Codeforces/ACM-style), with the exact constants configurable — see the Leaderboard epic for the proposed default formula.
- **Hosting:** Vercel (Next.js) + Supabase. No custom Node server required.
