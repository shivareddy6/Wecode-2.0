"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { verifySession, verifyRoomAccess, lookupRoomForJoin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isRoundPreset, selectRoundProblems } from "@/lib/problems/round-selection";

function generateInviteCode(): string {
  return randomBytes(6).toString("base64url");
}

// Epic 04, Story 1 (minimal) — creating a room is the only on-ramp now;
// there's no separate "solo mode" shortcut (solo just means you're the
// only participant in a room you host yourself).
export async function createRoom() {
  const { user } = await verifySession();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rooms")
    .insert({ host_user_id: user.id, invite_code: generateInviteCode() })
    .select("invite_code")
    .single();

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
export async function joinRoom(code: string) {
  const { user } = await verifySession();

  const room = await lookupRoomForJoin(code);
  if (!room) {
    redirect("/");
  }

  if (room.hostUserId === user.id) {
    return;
  }

  // Membership and the cap both need the service-role client: a
  // non-member can't see room_participants rows at all under RLS (that's
  // the point of the policy), including their own would-be row, so there
  // is no RLS-scoped way to answer "am I already in, and how full is it."
  const admin = createAdminClient();
  const { data: activeParticipants, error: rosterError } = await admin
    .from("room_participants")
    .select("user_id")
    .eq("room_id", room.id)
    .is("removed_at", null);

  if (rosterError) {
    throw new Error("Couldn't check room membership. Try again.");
  }

  const alreadyMember = (activeParticipants ?? []).some(
    (p) => p.user_id === user.id,
  );
  if (alreadyMember) {
    return;
  }

  if (room.status !== "open") {
    throw new Error("This room is closed and isn't accepting new participants.");
  }

  if ((activeParticipants?.length ?? 0) >= room.participantCap) {
    throw new Error("This room is full.");
  }

  // The insert itself goes through the normal RLS-scoped client, not the
  // admin one — "users can join a room for themselves" (user_id =
  // auth.uid()) is exactly the check this write needs, so satisfying it
  // via real RLS keeps the actual membership write inside the normal
  // authorization model rather than the service-role bypass.
  const supabase = await createClient();
  const { error: insertError } = await supabase
    .from("room_participants")
    .insert({ room_id: room.id, user_id: user.id });

  if (insertError) {
    throw new Error("Couldn't join the room. Try again.");
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
