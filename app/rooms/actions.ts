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

// Epic 05, Story 1/2 (minimal) — real session_problems row, real
// submissions later, but a fixed preset/duration and a hardcoded problem
// pool stand in for the real preset picker and random selection (that's
// Epic 05's own pass, not this one).
const DEFAULT_DURATION_SECONDS = 30 * 60;

export async function startSession(formData: FormData) {
  const roomId = formData.get("roomId");
  const slug = formData.get("slug");

  if (typeof roomId !== "string" || typeof slug !== "string") {
    throw new Error("Missing roomId or slug.");
  }

  const { user, isHost } = await verifyRoomAccess(roomId);
  if (!isHost) {
    throw new Error("Only the host can start a session.");
  }

  const entry = findCatalogEntry(slug);
  if (!entry) {
    throw new Error("Unknown problem.");
  }

  const supabase = await createClient();
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + DEFAULT_DURATION_SECONDS * 1000);

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      room_id: roomId,
      created_by: user.id,
      preset: "warm_up",
      duration_seconds: DEFAULT_DURATION_SECONDS,
      started_at: startedAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    throw new Error("Couldn't start session.");
  }

  const { error: problemError } = await supabase.from("session_problems").insert({
    session_id: session.id,
    leetcode_slug: entry.slug,
    leetcode_title: entry.title,
    difficulty: entry.difficulty,
    position: 1,
  });

  if (problemError) {
    throw new Error("Couldn't add problem to session.");
  }

  redirect(`/rooms/${roomId}/sessions/${session.id}`);
}
