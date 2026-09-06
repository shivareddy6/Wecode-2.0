import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Centralized session/authorization checks — every Server Component,
// Server Action, and Route Handler that needs to know who's asking calls
// through here, not through its own ad hoc supabase.auth.getUser() call.
// See ARCHITECTURE.md's "Authorization & Data Access Layer" section and
// Epic 01, Story 7 for why this exists and what it does and doesn't cover.
//
// getUser() (not getSession()) is deliberate: getSession() only reads the
// local cookie without revalidating it, getUser() round-trips to Supabase's
// Auth server to actually verify the JWT. cache() memoizes the result for
// the lifetime of one request/render pass, so calling verifySession() from
// several components in the same request doesn't mean several round trips.

export const verifySession = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/");
  }

  return { user: data.user };
});

// A DTO, not the raw table row: callers get exactly the fields that are
// safe to hand around the app, never user_credentials' encrypted columns
// even incidentally (e.g. via a careless `select("*")` elsewhere).
export type CurrentUser = {
  id: string;
  leetcodeId: string;
  leetcodeUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  isHouseAccount: boolean;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const { user } = await verifySession();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("users")
    .select(
      "id, leetcode_id, leetcode_username, display_name, avatar_url, is_house_account",
    )
    .eq("id", user.id)
    .single();

  if (error || !data) {
    // A valid Supabase Auth session with no matching public.users row is
    // a mid-sync state (see Epic 01, Story 1) — treat it the same as
    // being logged out rather than surfacing a raw DB error.
    redirect("/");
  }

  return {
    id: data.id,
    leetcodeId: data.leetcode_id,
    leetcodeUsername: data.leetcode_username,
    displayName: data.display_name,
    avatarUrl: data.avatar_url,
    isHouseAccount: data.is_house_account,
  };
});

// Resolves a room's short, shareable invite_code to its real internal id.
// Uses the normal RLS-scoped client, not a service-role bypass. The caller
// must already be a member/host for the row to come back at all; a
// non-member gets the same "not found" redirect as an unknown code, so
// this can't be used to enumerate rooms. For the "look up a room you're
// not a member of yet" case — Epic 04 Story 2's join flow — see
// lookupRoomForJoin below instead.
export async function resolveRoomIdByCode(code: string): Promise<string> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rooms")
    .select("id")
    .eq("invite_code", code)
    .maybeSingle();

  if (error || !data) {
    redirect("/");
  }

  return data.id;
}

// Service-role lookup of a room by invite_code for someone who isn't a
// member yet (Epic 04, Story 2's join flow) — the RLS "select" policy on
// rooms only ever grants access to existing members/host by design, so a
// prospective joiner can't be resolved through the normal RLS-scoped
// client at all (see SCHEMA.md's rooms entry, ARCHITECTURE.md's DAL
// section). This is one of the two existing service-role bypass paths in
// the app; it only ever returns the handful of fields the join Server
// Action (app/rooms/actions.ts's joinRoom) needs to decide whether joining
// is possible, never anything RLS wouldn't otherwise show a member.
export type JoinableRoom = {
  id: string;
  status: "open" | "closed";
  hostUserId: string;
  participantCap: number;
};

export async function lookupRoomForJoin(code: string): Promise<JoinableRoom | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("rooms")
    .select("id, status, host_user_id, participant_cap")
    .eq("invite_code", code)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    id: data.id,
    status: data.status as "open" | "closed",
    hostUserId: data.host_user_id,
    participantCap: data.participant_cap,
  };
}

// Room-scoped authorization, built on the same is_room_member/is_room_host
// SQL functions the RLS policies use (see SCHEMA.md's "Authorization
// model") — this is the app-code equivalent check for call sites that need
// to branch on membership/host status before even issuing a query, not
// just rely on RLS to filter results.
export async function verifyRoomAccess(roomId: string) {
  const { user } = await verifySession();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("is_room_member", {
    p_room_id: roomId,
  });
  const { data: isHost, error: hostError } = await supabase.rpc(
    "is_room_host",
    { p_room_id: roomId },
  );

  if (error || hostError) {
    redirect("/");
  }

  if (!data && !isHost) {
    redirect("/");
  }

  return { user, isHost: Boolean(isHost) };
}
