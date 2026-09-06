"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { verifySession, verifyRoomAccess } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
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
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Couldn't create room.");
  }

  redirect(`/rooms/${data.id}`);
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
  const slug = formData.get("slug");

  if (typeof roomId !== "string" || typeof slug !== "string") {
    throw new Error("Missing roomId or slug.");
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

  redirect(`/rooms/${roomId}/solve/${entry.slug}`);
}
