# WeCode v2 — Architecture Notes

This captures the technical decisions made while scoping the rebuild, and *why* — written for future-you picking this back up, given it's been a while since you were deep in Next.js. Pair with `PRD.md` (the what) and the `epics/` (the how, broken into stories).

## Identity & Auth

**Decision: drop Google. LeetCode account sync is the entire signup/login flow.**

A WeCode account only means something in relation to a LeetCode account — the leaderboard is literally your LeetCode submissions. Google was previously doing two jobs (proving identity, giving a display name/avatar), and both are already available for free once someone syncs their LeetCode session: LeetCode's public GraphQL API returns username and avatar for a logged-in session, and the sync itself proves the LeetCode account is real and currently controlled by the person syncing it.

Flow: extension grabs the LeetCode session cookie → posts it to a Route Handler → handler validates it by querying LeetCode's GraphQL for the logged-in user → look up a WeCode account by LeetCode's **numeric user ID** (not username — usernames are mutable on LeetCode, IDs aren't) → create one if it doesn't exist → provision/reuse a Supabase Auth user for that ID via Supabase's admin API → return a normal Supabase session.

Why bridge through Supabase Auth instead of inventing a bespoke session/JWT: the v1 schema already has Row Level Security policies keyed on `auth.uid()`. Reusing Supabase Auth as the session mechanism means those policies keep working unmodified — you're swapping *how someone proves their identity*, not the identity/authorization model itself.

Accepted tradeoff: no email on file, so no password-reset or email-notification path. Irrelevant for a friends tool; noted so it's a deliberate choice, not a gap someone finds later and wonders about.

**Decision: support two on-ramps to the same sync endpoint — the extension and manual credential paste — both from day one, treated identically.**

The sync Route Handler doesn't know or care whether the session/CSRF token it received came from the extension's popup or a form someone pasted values into by hand; both just POST the same shape of data. This means the two features never really compete for priority — they're two thin front-ends over one backend flow. Manual paste has real value on its own even with the extension shipped: it works in any browser (not just ones that support sideloading the extension), and it's a fallback the moment the extension has any issue.

**Decision: guest/demo mode is a shared "house" LeetCode account, not a separate judge.**

A true guest has no LeetCode session at all, and LeetCode's own Run/Submit endpoints require one — there's no way to get a real verdict for an anonymous visitor except by proxying through *some* real, logged-in LeetCode session. Rather than build a separate sandboxed code runner (a real new dependency, and a quiet reversal of the "always defer to LeetCode's judge" principle), one dedicated LeetCode account is synced into WeCode exactly like a normal user, and all demo submissions proxy through it against a small fixed problem pool. This reuses 100% of the Epic 03 submission-proxy path. The cost is concentration risk: one account absorbing all anonymous demo traffic is a more attractive target for LeetCode's abuse detection than the same volume spread across many real users, so demo traffic gets its own, tighter rate limit, and a stale house-account session degrades demo mode gracefully rather than taking down anything else.

## Authorization & Data Access Layer

**Decision: one centralized `verifySession()` function, not a `getUser()` call repeated independently in each handler.**

Next.js's own authentication guide is explicit that Proxy (`proxy.ts`) should never be the only line of defense — it's an optimistic, cookie-only check meant for fast redirects (including on prefetched routes), not real authorization. The guide's own words: *"the majority of security checks should be performed as close as possible to your data source."* Its recommended pattern for that is a **Data Access Layer (DAL)**: one function, memoized per request, that every Server Component, Server Action, and Route Handler calls as their first line — not each of them independently deciding how to check.

`lib/dal.ts` holds:

- **`verifySession()`** — calls `supabase.auth.getUser()`, wrapped in React's `cache()` so it only actually executes once per request even if a dozen components call it. Uses `getUser()`, never `getSession()`: `getUser()` revalidates the JWT against Supabase's Auth server, while `getSession()` only trusts whatever's in the local cookie — Supabase's own docs warn against using the latter for authorization decisions. If there's no valid user, it redirects to the sync flow (or calls Next's `unauthorized()`, stable since 15.1, for a real 401 where that's more appropriate than a redirect).
- **`getCurrentUser()`** — built on `verifySession()`, returns a DTO (name, avatar, LeetCode link status) rather than the full user row, so the encrypted LeetCode credential columns never end up serialized to a client-facing response just because a query happened to select everything.

Every Server Action (room/session/chat mutations) and every Route Handler calls `verifySession()` — or a scoped wrapper like `verifyRoomAccess(roomId)` built on top of it — as its first line, full stop. The docs are explicit that Server Actions and Route Handlers must be treated exactly like public API endpoints: hiding a button from unauthorized users in the UI is not a substitute for the handler checking for itself. Layouts are deliberately *not* where auth gets checked, either — layouts don't re-render on every client-side navigation, so a check placed there can silently get skipped on a route change.

This sits alongside Postgres RLS, not instead of it — and the two aren't redundant. RLS is a database-level backstop that still blocks a leak even if a handler's app-level check has a bug. But RLS provides **zero** protection for anything using Supabase's **service-role key**, which bypasses it by design — and we already have two such paths: provisioning a Supabase Auth user during LeetCode sync, and the submission-proxy's lookup of a user's encrypted LeetCode credentials. In those specific spots, the DAL-style explicit ownership check isn't a belt-and-suspenders extra on top of RLS — it's the only safeguard that exists at all.

The same principle now extends to the socket.io server (Epic 11): a socket connection authenticates by presenting its Supabase JWT, verified against Supabase's JWKS, and a room-scoped ownership check — conceptually the same as `verifyRoomAccess(roomId)` — has to pass before a socket is admitted to that room's channel. RLS does not cover this path at all, since the socket server talks to Postgres itself rather than through a browser-held Supabase session; the explicit check here is, again, the only safeguard, not a backup.

## Data & Real-time

**Decision (revised): a self-hosted socket.io server carries all real-time traffic — chat and the live leaderboard alike. No separate ORM.**

Next.js itself has no native WebSocket support — confirmed directly from the bundled Next 16 docs, which explicitly warn that on serverless/lambda-style hosting (including Vercel) a raw socket connection gets killed on timeout. Chat and a live leaderboard both need something outside plain Next.js to carry real-time updates.

The original plan here was Supabase Realtime, since it needed no new infrastructure and integrated directly with the RLS policies already in the v1 schema. That decision was revisited: Supabase Realtime's Postgres-Changes model is a great fit for "this row changed" (a leaderboard score genuinely is a row), but a weaker fit for events that don't need persisting at all (typing indicators, presence, a synced countdown tick) — those need Supabase's separate Broadcast/Presence APIs, a second surface. A self-hosted socket.io server gives one unified event model for both persisted and ephemeral events, and full control over room/channel authorization logic written in code rather than through a subscription model. That control is worth the added ops surface described below — but it's a real tradeoff, not a free upgrade:

- **Authorization moves from the database to application code.** With Supabase Realtime, RLS enforces "you only receive events for rooms you're in," automatically, for every subscription. With socket.io, the room/channel-join check has to be written explicitly (see Epic 11) — one more hand-authored authorization path, in the same category of risk the DAL (see above) exists to close off.
- **Writes and broadcasts become two coordinated steps instead of one.** Realtime notices a Postgres change and broadcasts it as part of the same operation; a socket.io setup has to write to Postgres and *then* separately emit the event from the same code path, or the live view and the persisted state can drift.
- **Hosting requirement**: a persistent Node process, which Vercel's serverless model can't run — see the Hosting section below for where it actually runs.

Alternatives considered and why not:
- **Pusher/Ably** — vendor-neutral, but a second paid service to configure, and every DB write needs a matching manual "publish this event" call, same as the self-hosted path, without the control benefit of owning the server. No clear advantage over self-hosting once we've already accepted the operational cost of not using Supabase Realtime.

**Decision: talk to Postgres via the Supabase client + generated types, not Prisma or Drizzle.**

Supabase already provides a typed client wired to RLS (`supabase gen types typescript`). Adding an ORM on top would mostly duplicate that. The one place extra query power would help — leaderboard ranking math — is better solved as a **Postgres view or RPC function** than an ORM query builder: it lives next to the data, and the socket.io server can compute a score from that same view/RPC when it broadcasts, so "how the leaderboard is computed" and "how the leaderboard updates live" still stay close together even without Realtime doing the subscribing. Revisit if the schema gets meaningfully more relational later — Drizzle is a low-cost add at that point.

## Next.js 16 patterns (what's changed since you last used this)

A researched summary of what's different from older Next.js habits, scoped to what's relevant here:

- **`middleware.ts` → `proxy.ts`.** Same job (route-level auth gating), renamed file/export in this version. Start the new project with `proxy.ts` directly. It also now defaults to the **Node.js runtime**, not the old Edge-only restriction — full Node API access is available there if needed, though the docs still recommend keeping proxy checks "optimistic" (cookie presence/validity only) and doing real authorization (can this user access this room?) closer to the data.
- **Route Handlers vs Server Actions.** Use plain Route Handlers (`app/api/.../route.ts`) for anything the browser extension calls (cookie sync) and for the LeetCode submission proxy + verdict polling — these are external-client or poll-driven flows, and Server Actions are dispatched **sequentially per client**, which is wrong for polling. Use Server Actions for mutations from your own UI: create room, join room, start/end a session, post a chat message.
- **Caching model.** The old "fetch is cached by default" surprise from Next 13/14 is gone. The newer model (`cacheComponents: true` + the `'use cache'` directive) makes caching fully opt-in and explicit — worth adopting from day one so it's clear what's cached (problem descriptions, room metadata) versus always-live (chat, leaderboard, submission status). `'use cache'` pairs with `cacheLife()` (time-based expiry) and `cacheTag()` + `revalidateTag`/`updateTag` (on-demand invalidation).

## Browser Extension

**Decision: sideload (unpacked zip), not the Chrome Web Store.**

No review process, ships instantly, matches a friends-only tool. Cost: friends need to enable developer mode and load it manually — acceptable friction for this audience. The extension's API base URL must be a build-time config value pointed at the deployed domain (v1's hardcoded-localhost mistake), with a separate dev build for local development.

## Hosting

**Decision: Vercel (Next.js app) + Supabase (Postgres/Auth) + a standalone socket.io service on Fly.io or Railway (all real-time traffic).**

The Next.js app itself still doesn't need a custom server — Vercel's standard adapter-based deployment (streaming, Server Actions, Cache Components) stays sufficient for everything except real-time. The socket.io server is a genuinely separate, always-on Node process, deployed independently to a host built for persistent connections (Fly.io or Railway — either is a small, low-maintenance choice compared to running a raw VPS/Docker setup by hand). This means two deploy targets instead of one, and the Next.js client needs to know the socket server's URL (see Epic 09 for keeping that configuration consistent) — a real increase in moving parts, accepted deliberately for the control described above.

## Security posture (baseline, detailed in the Security epic)

- LeetCode session cookie + CSRF token encrypted at rest at the application layer (a server-side secret, decrypted only inside the submission-proxy Route Handler at call time) — RLS alone protects against other *users* reading it through the app, not against a raw database compromise.
- Submission-proxy calls are rate-limited per user and globally, since WeCode's traffic pattern hitting LeetCode's servers on behalf of many users is exactly the kind of thing LeetCode's own abuse detection might flag — self-throttling protects the whole app's ability to function, not just one user's account.
- Rooms are joinable by anyone with the invite link (no host approval step), so room/participant counts are capped and invite links are revocable, to keep the "semi-public, shareable" model bounded.
