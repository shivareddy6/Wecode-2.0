# Epic 07 — Chat

**Goal:** Real-time, room-scoped text chat — the social glue that makes a session feel like hanging out rather than four people silently solving in parallel.

---

### Story 1 — Send and receive messages
As a participant, I want to send and receive text messages with everyone currently in the room, so we can talk while solving.

- Acceptance criteria:
  - Messages delivered via the socket.io server (Epic 11) to all current room participants.
  - Messages persist for the life of the room and are visible as history to participants who join later.

**Status: Done (2026-09-21).** `chat_messages` (schema, RLS, and its "room members and host can view/post chat" policies) already existed from the very first migration (`20260815084024_v2_schema.sql`) — this story is the first app code that actually uses it. `sendMessage` (`apps/web/app/rooms/actions.ts`) inserts under RLS then broadcasts via Epic 11's `POST /internal/broadcast` (`chat:message` event) — same "write, then broadcast on the same request" shape as Epic 06 Story 2's leaderboard push and Epic 04 Story 3's roster push. `apps/web/app/rooms/[code]/page.tsx` fetches the last 100 non-deleted messages (ordered ascending) as SSR history; `components/chat.tsx` (new client component, same socket pattern as `LiveLeaderboard`/`ParticipantList`) layers the live push on top, re-`room:join`ing on every connect/reconnect. History is capped, not paginated — a casual friends tool, not an archive.

### Story 2 — Sender identity
As a participant, I want to see who sent each message, so conversations are easy to follow.

- Acceptance criteria:
  - Each message displays the sender's name and avatar, sourced from their LeetCode profile.

**Status: Done (2026-09-21), landed together with Story 1.** `sendMessage` joins the inserted row against `users(display_name, avatar_url)` and includes both in the `chat:message` broadcast payload, so every listening client renders identity without a separate lookup. `components/chat.tsx` renders both: a plain `<img>` (not `next/image`) since `avatar_url` is an arbitrary LeetCode-hosted URL, not a project asset next/image's optimizer can handle.

### Story 3 — Basic moderation
As a host, I want to delete a message or remove a participant from chat, so the room stays usable in a group of friends.

- Acceptance criteria:
  - A host can delete any message in their room.
  - Removing a participant from the room (Epic 04, Story 4) also removes their chat access.

**Status: Done (2026-09-21).** `deleteMessage` (`apps/web/app/rooms/actions.ts`) is host-only, a soft-delete (`deleted_at`, same shape as `removeParticipant`'s `removed_at`) followed by a `chat:delete` broadcast so any open chat tab drops the message live. The `"message owner or host can soft-delete a message"` RLS policy (v2 schema) is actually broader than what's exposed here — it also lets a message's own author delete it — but nothing in the app calls that path; only host moderation is wired up, matching this story's AC exactly. Removing a participant's chat access needed no new code: `chat_messages`' select/insert policies already gate on `is_room_member()`/`is_room_host()`, the same `removed_at is null` check every other room-scoped RLS policy uses, so a kick (Epic 04, Story 4) already revokes chat access the instant the DB write lands — verified directly in `verify-chat.ts` rather than assumed.

### Story 4 — Input limits
As the system, I want basic sanitization and a length limit on chat messages, so the app isn't trivially abusable for spam or injection.

- Acceptance criteria:
  - Messages are sanitized before storage/render (no raw HTML execution).
  - Messages beyond a reasonable length are rejected client- and server-side.

**Status: Done (2026-09-21).** Length limit: `MAX_MESSAGE_LENGTH = 2000` (`apps/web/lib/chat/constants.ts`, matching `chat_messages`' pre-existing `char_length(body) <= 2000` check constraint exactly) is enforced client-side (`<input maxLength>` plus a check before calling the action) and server-side (`sendMessage` throws a readable error before ever inserting) — the DB constraint is the last-resort backstop, not the primary enforcement. HTML sanitization needed no sanitizer library: the body is stored as plain `text`, and its only render path (`components/chat.tsx`) uses ordinary JSX text interpolation, which React escapes by default; nothing in this codebase uses `dangerouslySetInnerHTML` on chat content, so raw HTML execution isn't reachable.

### Story 5 — Submission activity in chat
As a participant, I want to see when someone in the room submits a problem, so the room feels alive without everyone having to announce it themselves.

- Acceptance criteria:
  - A system-style chat entry appears when a participant's submission is judged, naming the participant, the problem, and the verdict.
  - A submission flagged `is_out_of_contest` (Epic 05, Story 5 — made after the round's deadline) is visibly marked as out-of-contest in that chat entry, distinct from an in-contest one, so it's never mistaken for a scoring submission.

**Status: Done (2026-09-22).** Needed one small schema addition, confirmed with the user first since it's a real design fork: `chat_messages` gained `kind` (`'user' | 'submission'`, default `'user'`) and `is_out_of_contest` (boolean, default `false`) columns (`supabase/migrations/20260922090000_chat_submission_activity.sql`, applied live via the Supabase MCP). A submission event couldn't just be computed at render time instead — `submissions` rows get wiped on every `start_room_round()`, while chat is meant to survive round transitions (see `docs/SCHEMA.md`'s "Chat spans rounds regardless" note) — so it has to be a real, persisted `chat_messages` row, and it needs a real column to key rendering off rather than sniffing formatted text (the option considered and rejected: encoding "system message" and "out of contest" only inside the body string).
- `app/api/submissions/[id]/status/route.ts` — right after a submission's final verdict lands (the same `if (status.state === "SUCCESS" || status.state === "FAILURE")` block Epic 06 Story 2's leaderboard push already lives in), looks up the problem's title from `rooms.current_problems` (falling back to the raw slug if the round has since moved on), builds a body like `"Alice solved Two Sum (medium)"` or `"Alice attempted Two Sum — Wrong Answer"`, and inserts a `chat_messages` row with `kind: "submission"` and `is_out_of_contest` copied straight from the submission — then broadcasts it as an ordinary `chat:message` event, so it arrives through the exact same socket path as a typed message.
- `components/chat.tsx` renders `kind: "submission"` entries distinctly (italic, no sender-name prefix since the body already names them) and shows a small "out of contest" badge when `is_out_of_contest` is true — both driven by the new columns, not by parsing the body text.
- Verified end-to-end in `verify-chat.ts` (extended, not a separate script) by seeding `current_problems` directly and inserting `submissions` rows directly — standing in for the real LeetCode-judging call, the same stand-in `verify-leaderboard-push.ts` already uses — then running the exact insert-then-broadcast the route makes: an in-contest accept and an out-of-contest accept both produce a correctly-flagged `chat:message` push. 15/15 checks passing (`npm run verify:chat -w web`).
