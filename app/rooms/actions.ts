"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { verifySession, verifyRoomAccess, lookupRoomForJoin } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findCatalogEntry } from "@/lib/problems/catalog";

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

// Epic 05, Story 1/2 (minimal) — a fixed preset/duration and a hardcoded
// problem pool stand in for the real preset picker and random selection
// (Epic 05's own pass). The actual round transition — snapshotting the
// outgoing round's slugs into permanent anti-repeat memory, clearing its
// submissions, installing the new round — happens atomically in
// start_room_round() (see the room-centric-rounds migration), not as
// separate queries here: this is deliberately a thin wrapper around one
// RPC call, not the source of that logic.
const DEFAULT_DURATION_SECONDS = 30 * 60;

export async function startRound(formData: FormData) {
  const roomId = formData.get("roomId");
  const code = formData.get("code");
  const slug = formData.get("slug");

  if (typeof roomId !== "string" || typeof code !== "string" || typeof slug !== "string") {
    throw new Error("Missing roomId, code, or slug.");
  }

  const { isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can start a round.");
  }

  const entry = findCatalogEntry(slug);
  if (!entry) {
    throw new Error("Unknown problem.");
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("start_room_round", {
    p_room_id: roomId,
    p_problems: [{ slug: entry.slug, title: entry.title, difficulty: entry.difficulty }],
    p_duration_seconds: DEFAULT_DURATION_SECONDS,
    p_preset: "warm_up",
  });

  if (error) {
    throw new Error(error.message);
  }

  redirect(`/rooms/${code}/solve/${entry.slug}`);
}
