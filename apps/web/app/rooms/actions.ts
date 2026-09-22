"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { verifySession, verifyRoomAccess, lookupRoomForJoin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { isRoundPreset, selectRoundProblems } from "@/lib/problems/round-selection";
import { broadcastToRoom, disconnectUserFromRoom } from "@/lib/realtime/broadcast";
import { MAX_MESSAGE_LENGTH } from "@/lib/chat/constants";

type ParticipantRow = { user_id: string; display_name: string | null };

// Epic 04, Story 3 — recomputes the active roster and pushes it over
// Epic 11's socket channel, the same "write, then broadcast on the same
// request" shape as Epic 06 Story 2's leaderboard push. Called from
// joinRoom/removeParticipant only when the roster actually changed, not
// on every no-op call — see join_room()'s comment on why it now reports
// back whether it inserted a row.
async function broadcastParticipantList(roomId: string): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("room_participants")
    .select("user_id, users(display_name)")
    .eq("room_id", roomId)
    .is("removed_at", null);

  const rows: ParticipantRow[] = (data ?? []).map((row) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    return { user_id: row.user_id, display_name: user?.display_name ?? null };
  });

  await broadcastToRoom(roomId, "participants:update", rows);
}

function generateInviteCode(): string {
  return randomBytes(6).toString("base64url");
}

// Epic 04, Story 1 (minimal) — creating a room is the only on-ramp now;
// there's no separate "solo mode" shortcut (solo just means you're the
// only participant in a room you host yourself).
//
// Epic 04/06 design decision — the host gets a real room_participants row
// from the moment the room exists, same as anyone who joins later, rather
// than being tracked purely via rooms.host_user_id (see docs/SCHEMA.md's
// "Room membership: the host is a participant too"). create_room() does
// both inserts atomically in one SQL function, the same "one round trip,
// not two app-layer ones" shape as join_room()/start_room_round() — a
// raw two-step insert here would risk an orphaned room with no host
// participant row if the second insert failed.
export async function createRoom() {
  await verifySession();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("create_room", {
    p_invite_code: generateInviteCode(),
  });

  if (error || !data) {
    throw new Error("Couldn't create room.");
  }

  redirect(`/rooms/${data.invite_code}`);
}

// Epic 04, Story 2 — join a room by invite code. Called directly from
// app/rooms/[code]/page.tsx's render (not from a <form>) so that simply
// opening the link joins automatically per the story's acceptance
// criteria; it's still a Server Action, per ARCHITECTURE.md's "join room"
// call-out, not a page doing the mutation itself. A no-op for the host or
// an already-active participant, so it's safe to call on every page load.
//
// All of the actual host/membership/status/cap logic lives in the
// join_room() SQL function (join_room_atomic migration), not here — this
// used to be a separate "read the roster, then insert" pair of app-layer
// queries, which raced: two concurrent joins could both read a
// still-under-cap count and both insert, overfilling the room past
// participant_cap. join_room() locks the room row (`FOR UPDATE`) before
// checking or inserting anything, so concurrent callers serialize on that
// lock instead of racing past each other.
export async function joinRoom(code: string) {
  await verifySession();

  const room = await lookupRoomForJoin(code);
  if (!room) {
    redirect("/");
  }

  const supabase = await createClient();
  const { data: didJoin, error } = await supabase.rpc("join_room", { p_room_id: room.id });

  if (error) {
    throw new Error(error.message);
  }

  // join_room() returns true only for an actual new insert, false for the
  // ordinary "already a member" no-op this gets called with on every page
  // render — only broadcast when the roster really changed.
  if (didJoin) {
    await broadcastParticipantList(room.id);
  }
}

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 180;

// Epic 05, Story 1/2 (real pass) — host picks a preset + duration;
// selectRoundProblems (lib/problems/round-selection.ts) does the actual
// random selection matching that preset's difficulty counts, filtered
// against every slug this room has ever run. This function is still just
// the thin wrapper it always was: the atomic round transition —
// snapshotting the outgoing round's slugs into permanent anti-repeat
// memory, clearing its submissions, installing the new round — happens in
// start_room_round() (see the room-centric-rounds migration), not here.
export async function startRound(formData: FormData) {
  const roomId = formData.get("roomId");
  const code = formData.get("code");
  const preset = formData.get("preset");
  const durationMinutesRaw = formData.get("durationMinutes");

  if (
    typeof roomId !== "string" ||
    typeof code !== "string" ||
    typeof preset !== "string" ||
    typeof durationMinutesRaw !== "string" ||
    !isRoundPreset(preset)
  ) {
    throw new Error("Missing roomId, code, or preset.");
  }

  const durationMinutes = Number(durationMinutesRaw);
  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes < MIN_DURATION_MINUTES ||
    durationMinutes > MAX_DURATION_MINUTES
  ) {
    throw new Error(`Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can start a round.");
  }

  const supabase = await createClient();

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("used_leetcode_slugs")
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new Error("Couldn't read the room's history. Try again.");
  }

  const selection = selectRoundProblems(preset, room.used_leetcode_slugs);
  if (!selection.ok) {
    throw new Error(selection.error);
  }

  const { error } = await supabase.rpc("start_room_round", {
    p_room_id: roomId,
    p_problems: selection.problems,
    p_duration_seconds: durationMinutes * 60,
    p_preset: preset,
  });

  if (error) {
    throw new Error(error.message);
  }

  redirect(`/rooms/${code}`);
}

// Epic 05, Story 6 — host ends the round immediately, without starting a
// new one, so participants can see it's over (and, once Epic 06 exists, a
// locked leaderboard) before the host decides what's next. Distinct from
// startRound, which always ends the current round implicitly by replacing
// it — this leaves current_problems/round_started_at in place and just
// flips round_status, matching start_room_round's own "same finalization
// as automatic expiry" language in the epic's AC. A direct rooms update,
// not the finalize_expired_round RPC — that one's SECURITY DEFINER so any
// member can trigger it for a genuinely expired round; this is host-only
// and the "hosts manage their own rooms" RLS policy already allows it
// directly.
export async function endRound(formData: FormData) {
  const roomId = formData.get("roomId");

  if (typeof roomId !== "string") {
    throw new Error("Missing roomId.");
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can end a round.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ round_status: "ended" })
    .eq("id", roomId)
    .eq("round_status", "active");

  if (error) {
    throw new Error("Couldn't end the round. Try again.");
  }

  // No redirect() here (unlike startRound/createRoom) — the host stays on
  // the room page, so the mutation needs an explicit refresh() (Next 16's
  // next/cache API) for the now-ended round_status to actually show up.
  refresh();
}

// Epic 04, Story 4 — host removes a participant. A direct table update
// under RLS, the same shape as endRound above, not a new RPC: the
// "hosts can remove participants" policy (host_is_a_participant
// migration) already restricts this update to the host and already
// excludes the host's own row, so there's no host/self-target logic to
// duplicate here — an attempt to target the host (or by a non-host
// caller) just matches zero rows at the DB layer.
//
// Soft-delete only (removed_at, not a deleted row) — see docs/SCHEMA.md's
// "Removal is soft" note: chat and leaderboard history stay attributable
// to a real person after a kick. join_room() (kick_participant migration)
// separately rejects any future rejoin attempt from this user for this
// room, per the 2026-09-17 product decision that kicked means kicked.
//
// The DB write alone already revokes access going forward (every
// room-scoped RLS policy runs through is_room_member(), which checks
// removed_at is null) — disconnectUserFromRoom is the "immediately" part
// of the AC, forcing any socket connection this user already has open
// (e.g. a leaderboard tab) to leave the room channel right now instead
// of waiting for its next natural reconnect.
export async function removeParticipant(formData: FormData) {
  const roomId = formData.get("roomId");
  const targetUserId = formData.get("userId");

  if (typeof roomId !== "string" || typeof targetUserId !== "string") {
    throw new Error("Missing roomId or userId.");
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can remove a participant.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("room_participants")
    .update({ removed_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("user_id", targetUserId)
    .is("removed_at", null)
    .select("user_id");

  if (error) {
    throw new Error("Couldn't remove that participant. Try again.");
  }

  if (!data || data.length === 0) {
    throw new Error("That participant isn't in this room (or can't be removed).");
  }

  await disconnectUserFromRoom(roomId, targetUserId);
  await broadcastParticipantList(roomId);

  // No redirect() — the host stays on the room page, same as endRound.
  refresh();
}

// Epic 04, Story 5 — host closes the room: a hard stop on new joins and
// new rounds, not an archival step (per the AC's own "nothing about the
// room is required to remain viewable once closed" line). A direct
// table update under RLS, the same shape as endRound/removeParticipant —
// no new RPC needed. The two enforcement points already exist elsewhere,
// not here: join_room() has rejected non-open rooms since Story 2, and
// start_room_round() gained the same status check alongside this story
// (close_room migration). This action only ever needs to flip the flag.
export async function closeRoom(formData: FormData) {
  const roomId = formData.get("roomId");

  if (typeof roomId !== "string") {
    throw new Error("Missing roomId.");
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can close the room.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("rooms")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", roomId)
    .eq("status", "open");

  if (error) {
    throw new Error("Couldn't close the room. Try again.");
  }

  // No redirect() — the host stays on the room page, same as endRound.
  refresh();
}

// Epic 07, Story 1/2/4 — post a chat message. No refresh() here: unlike
// the host-only mutations above, the sender already has an open room
// socket (components/chat.tsx) and gets their own message back the same
// way everyone else does, via the "chat:message" broadcast below — a
// second, redundant page refresh would just fight that.
//
// Length/emptiness are checked here even though chat_messages already has
// a `char_length(body) <= 2000` constraint, so a bad message fails with a
// readable error instead of a raw Postgres constraint violation. Sanitizing
// against HTML execution (Story 4) needs no code here: the body is stored
// as plain text and every render path (this table's only consumer,
// components/chat.tsx) uses ordinary JSX text interpolation, which React
// escapes by default — never dangerouslySetInnerHTML.
export async function sendMessage(formData: FormData) {
  const roomId = formData.get("roomId");
  const bodyRaw = formData.get("body");

  if (typeof roomId !== "string" || typeof bodyRaw !== "string") {
    throw new Error("Missing roomId or body.");
  }

  const body = bodyRaw.trim();
  if (body.length === 0) {
    throw new Error("Message can't be empty.");
  }
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
  }

  const { user } = await verifyRoomAccess(roomId);

  const supabase = await createClient();
  const { data: message, error } = await supabase
    .from("chat_messages")
    .insert({ room_id: roomId, user_id: user.id, body })
    .select("id, room_id, user_id, body, created_at, kind, is_out_of_contest, users(display_name, avatar_url)")
    .single();

  if (error || !message) {
    throw new Error("Couldn't send that message. Try again.");
  }

  const sender = Array.isArray(message.users) ? message.users[0] : message.users;

  await broadcastToRoom(roomId, "chat:message", {
    id: message.id,
    room_id: message.room_id,
    user_id: message.user_id,
    body: message.body,
    created_at: message.created_at,
    kind: message.kind,
    is_out_of_contest: message.is_out_of_contest,
    display_name: sender?.display_name ?? null,
    avatar_url: sender?.avatar_url ?? null,
  });
}

// Epic 07, Story 3 — host-only moderation: delete any message in their
// room. A soft-delete (deleted_at), same shape as removeParticipant's
// removed_at, not a hard delete — the "message owner or host can
// soft-delete" RLS policy (v2_schema migration) also permits the message's
// own author, but nothing in the app exposes that yet since the epic's AC
// only calls for host moderation; the RLS policy already being broader than
// what's wired up here isn't a gap to fix, just unused headroom.
export async function deleteMessage(formData: FormData) {
  const roomId = formData.get("roomId");
  const messageId = formData.get("messageId");

  if (typeof roomId !== "string" || typeof messageId !== "string") {
    throw new Error("Missing roomId or messageId.");
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can delete a message.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("chat_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("room_id", roomId)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    throw new Error("Couldn't delete that message. Try again.");
  }
  if (!data || data.length === 0) {
    throw new Error("That message doesn't exist in this room (or was already deleted).");
  }

  await broadcastToRoom(roomId, "chat:delete", { id: messageId });
}
