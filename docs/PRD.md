# WeCode v2 — Product Requirements Document

## 1. Vision

WeCode turns solo LeetCode practice into something you do *with* your friends. You create a room, friends join with a link, the room runs timed contests against real LeetCode problems, everyone's code is genuinely judged by LeetCode (not a reimplementation), a live leaderboard tracks who's ahead, and you chat the whole time. It's built for casual use among a friend group, not as a public product.

## 2. Background — what v1 actually was

A prior version of this project (see repo history) proved out the hardest and most novel technical piece: impersonating a user's logged-in LeetCode session (via a browser extension that syncs session cookies) to submit code and get a real verdict back from LeetCode's own judge. That loop worked end to end for a single user solving a single problem they already knew the URL for.

Everything the project is actually named for — rooms, inviting friends, chat, and the leaderboard — was never built. Development stopped right after the submission-proxy started working, before the multiplayer layer was started. v1 also only ran on localhost, stored the synced LeetCode session in plaintext, used Google as a separate login step, and locked users into a single coding language.

v2 is a from-scratch rebuild that keeps the validated idea (real LeetCode judging via session sync) and actually builds the social/competitive layer, hardened enough to deploy and share with friends.

## 3. Goals for v2

- Ship the complete core loop: create a room → invite friends → run a timed, multi-problem contest → get real LeetCode-graded results → see a live leaderboard.
- Make LeetCode account sync *be* the login flow — one identity, no separate auth provider.
- Support two equally-supported ways to sync a LeetCode session at launch: the browser extension (automatic) and manual credential entry (paste the session/CSRF token by hand).
- Add real-time chat scoped to each room.
- Let a visitor try the room/editor experience with zero signup via a standalone demo sandbox, before deciding to sync their own account.
- Deploy somewhere friends can actually reach it (not localhost), with the encryption and abuse-prevention baseline that requires.
- Let each host tune session difficulty via presets and let each user pick their preferred coding language.

## 4. Non-Goals / Out of Scope for v2

- Mobile app (web-only, responsive is enough).
- A custom in-house code judge — WeCode always defers to LeetCode's real judge, including in demo mode (see §13), which proxies through a shared house LeetCode account rather than a separate judge.
- Publishing the browser extension to the Chrome Web Store (sideload/unpacked distribution only for now).
- Persistent, long-lived "standing" rooms that accumulate history across many separate hangouts (rooms are ephemeral — see Rooms epic).
- Cumulative/room-wide leaderboard totals across multiple sessions (leaderboard resets each session — see Leaderboard epic).
- Monetization, public discovery/browsing of rooms, or any multi-tenant/organization concept.
- Video/voice chat (text chat only).

## 5. Users

There is effectively one persona with two hats:

- **Host** — creates a room, configures and starts sessions (difficulty preset, timer), can remove participants and close the room.
- **Participant** — joins via invite link, syncs their LeetCode account, solves problems during sessions, chats, sees the leaderboard.

Everyone is a participant by default; hosting is just an action available to whoever created the room. No separate roles/permissions system beyond that.

## 6. Key user journey

1. A friend shares a WeCode invite link (or you create a room and share the link yourself).
2. If you don't have a WeCode account yet, opening the link routes you through: install/open the WeCode browser extension → log into leetcode.com if you aren't already → hit "Sync" → your WeCode account is created and you're logged in, automatically continuing into the room you were invited to.
3. Inside the room, you see who else has joined and can chat with them.
4. The host starts a session: picks a difficulty preset (see Sessions epic) and a duration. WeCode randomly selects problems matching that preset.
5. Everyone solves the selected problems in their own editor, in their own preferred language, submitting for real judging against LeetCode. The leaderboard updates live as people get problems Accepted.
6. When the timer runs out (or the host ends it early), the session locks and final standings are shown.
7. The host can start another session in the same room (new problems, timer reset, leaderboard resets), or close the room when the hangout is over.

## 7. Functional requirements (by epic)

See `epics/` for full detail. Summary:

- **Identity & LeetCode Linking** — sync-as-signup/login (via extension or manual paste), keyed to LeetCode's stable numeric user ID, encrypted credential storage, stale-session detection.
- **Browser Extension** — sideloadable, points at the deployed domain, one-click sync; one of two supported on-ramps to the same sync endpoint.
- **Guest / Demo Mode** — zero-signup sandbox with a fixed problem pool, graded via a shared house LeetCode account.
- **Solo Solve Experience** — real problem fetch, in-app editor with a choice of common languages, real submission + polling for verdict.
- **Rooms** — create, invite-link join, participant list/removal, host closes room, archived history.
- **Sessions (Contests)** — host picks a difficulty preset + duration, random problem selection, live countdown, auto-end, repeatable within the same room.
- **Leaderboard & Scoring** — time-decay + wrong-submission-penalty scoring, live updates, resets per session.
- **Chat** — real-time, room-scoped text chat with basic host moderation.
- **Security & Abuse Prevention** — encryption at rest, submission rate limiting, room/participant caps, revocable invite links.
- **Deployment & Ops** — Vercel + Supabase, versioned schema, monitoring.

## 8. Session configuration — difficulty presets

Rather than free-form difficulty/topic filters, the host picks one of four fixed presets when starting a session. Each preset is 4 problems total, escalating in difficulty:

| Preset | Composition |
|---|---|
| Warm-up | 3 Easy, 1 Medium |
| Balanced | 2 Easy, 2 Medium |
| Challenge | 1 Easy, 2 Medium, 1 Hard |
| Gauntlet | 1 Easy, 1 Medium, 2 Hard |

Problems are randomly selected from LeetCode's catalog to match the chosen preset's difficulty counts. (Preset names are placeholders — cosmetic, easy to rename later.)

## 9. Language support

At launch, users may solve in any of: **Python3, Java, C++, JavaScript, Go, C**. Language selection is a pass-through to LeetCode's own per-problem starter code and judge — WeCode does not run or grade code itself, so adding a language later is a small addition (one more entry in the supported-language list), not a new judge to build.

## 10. Non-functional requirements

- **Real-time**: chat messages and leaderboard score changes should reflect for other participants within roughly a second or two, not require a manual refresh.
- **Security**: LeetCode session credentials encrypted at rest; invite links revocable; submission-proxy traffic rate-limited to avoid LeetCode flagging WeCode's shared usage pattern as abuse.
- **Scale**: "semi-public, shareable" — anyone with a link can join, but the app is sized for friend-group usage (tens of concurrent users, single-digit-to-low-double-digit concurrent rooms), not public/viral scale. Caps on room/participant counts exist to keep this bounded, not to serve as a growth constraint.
- **Reliability**: a stale/expired LeetCode session should degrade gracefully (clear "reconnect" prompt) rather than breaking the user's WeCode session entirely.

## 11. Explicit assumptions (flag if wrong)

- Joining a room via invite link is instant — no host approval step. The host can remove someone after the fact if needed.
- Chat history persists for the life of the room (visible to participants who join later) but isn't retained after the room is archived/closed.
- A session's problems, once randomly selected at start, are fixed for that session (not re-rolled), and WeCode tries to avoid repeating a problem already used earlier in the same room.
- Submissions that begin judging before a session's deadline still count even if the verdict resolves a moment after; submissions initiated after the deadline are rejected.

## 12. Success criteria

v2 is successful when: a host can create a room, four+ friends can join via a shared link with zero manual account setup beyond the LeetCode sync flow, run a full timed session end-to-end with real LeetCode-graded submissions, see an accurate live leaderboard, chat throughout, and do this from a real deployed URL — not localhost. That's the complete loop v1 never reached.

## 13. Guest / Demo Mode

A visitor with no WeCode account and no synced LeetCode session can open a standalone demo sandbox (not a real room) and try the editor against a small, fixed pool of problems. Submissions are proxied through a single shared "house" LeetCode account maintained by the developer — this gives genuinely real Accepted/Wrong-Answer verdicts without needing the visitor's own session, and without building a separate judge (it's the same submission-proxy mechanism every real user uses, just pointed at a house account instead of the visitor's).

Because this concentrates submission-proxy traffic onto one account, demo-mode traffic is rate-limited more aggressively than normal user traffic (see Epic 08), and the demo problem pool stays small and fixed rather than open to the full LeetCode catalog. The house account's session can go stale like any other — when it does, demo mode degrades (e.g. showing a "try it live" CTA instead of live grading) rather than breaking the rest of the app. The demo sandbox always ends with a clear call-to-action to sync a real account and create/join an actual room.

## 14. Manual Credential Entry

Alongside the browser extension, a user can sync their LeetCode account by manually pasting their session token and CSRF token into a form (exact field names/values to be confirmed against LeetCode's current cookie names when this is built — referred to generically here as "session token" and "CSRF token"). Both on-ramps post to the same sync endpoint and are treated identically afterward — the backend has no notion of "extension user" vs "manual-paste user." This is intentional: it means either path can be built, deployed, or deprecated independently without touching the other, and a user isn't locked into whichever method they used first (someone who synced manually can resync later via the extension, or vice versa).

