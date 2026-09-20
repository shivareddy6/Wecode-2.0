import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// Epic 04, Story 5 — end-to-end smoke test for closing a room. Exercises
// the exact DB write app/rooms/actions.ts's closeRoom makes (a
// status='open' -> 'closed' update, host-only + already-closed guarded by
// the same .eq("status", "open") filter as the real action), then asserts
// the two enforcement points closing is supposed to hard-stop
// (join_room(), start_room_round()) while confirming existing members
// keep their read access, per the epic's "closing is a hard stop, not an
// archival step" AC. Self-cleaning regardless of pass/fail. No socket
// server dependency (unlike the other Epic 04 verify scripts) — closing a
// room doesn't push anything live.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok  - ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail });
    console.log(`FAIL  - ${name}: ${detail}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function createAuthedUser(): Promise<{ userId: string; accessToken: string }> {
  const email = `verify-${randomUUID()}@users.wecode.internal`;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link) {
    throw new Error(`generateLink failed: ${linkError?.message}`);
  }

  const anon = createClient<Database>(supabaseUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });
  if (verifyError || !verified.session) {
    throw new Error(`verifyOtp failed: ${verifyError?.message}`);
  }

  return { userId: link.user.id, accessToken: verified.session.access_token };
}

function asUser(accessToken: string) {
  return createClient<Database>(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function main() {
  const host = await createAuthedUser();
  const member = await createAuthedUser();
  const latecomer = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    { id: member.userId, leetcode_id: `verify-member-${member.userId}`, leetcode_username: "verify-member" },
    {
      id: latecomer.userId,
      leetcode_id: `verify-latecomer-${latecomer.userId}`,
      leetcode_username: "verify-latecomer",
    },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const memberClient = asUser(member.accessToken);
  const latecomerClient = asUser(latecomer.accessToken);

  const { error: memberJoinError } = await memberClient.rpc("join_room", { p_room_id: roomId });
  if (memberJoinError) throw new Error(`join_room (member) failed: ${memberJoinError.message}`);

  try {
    await check("non-host cannot close the room (RLS excludes non-hosts)", async () => {
      const { data, error } = await memberClient
        .from("rooms")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", roomId)
        .eq("status", "open")
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "a non-host update should have matched zero rows");
    });

    await check("closeRoom's DB write (host closes the room)", async () => {
      const { data, error } = await hostClient
        .from("rooms")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", roomId)
        .eq("status", "open")
        .select("id, status, closed_at");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be closed");
      assert(data![0]!.status === "closed", "status should now be closed");
      assert(!!data![0]!.closed_at, "closed_at should be set");
    });

    await check("closing again is a no-op (already-closed filter matches zero rows)", async () => {
      const { data, error } = await hostClient
        .from("rooms")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", roomId)
        .eq("status", "open")
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "a second close should match zero rows");
    });

    await check("a new participant cannot join the closed room", async () => {
      const { error } = await latecomerClient.rpc("join_room", { p_room_id: roomId });
      assert(!!error, "expected join_room to reject a closed room");
      assert(
        (error?.message ?? "").includes("closed"),
        `expected a "closed" error, got: ${error?.message}`,
      );
    });

    await check("the host cannot start a new round in a closed room", async () => {
      const { error } = await hostClient.rpc("start_room_round", {
        p_room_id: roomId,
        p_problems: [{ slug: "two-sum", title: "Two Sum", difficulty: "easy" }],
        p_duration_seconds: 1800,
        p_preset: "warm_up",
      });
      assert(!!error, "expected start_room_round to reject a closed room");
      assert(
        (error?.message ?? "").includes("closed"),
        `expected a "closed" error, got: ${error?.message}`,
      );
    });

    await check("an existing member keeps read access to the closed room", async () => {
      const { data, error } = await memberClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "existing member should still be a room member after closing");

      const { data: roomRow, error: readError } = await memberClient
        .from("rooms")
        .select("status")
        .eq("id", roomId)
        .single();
      if (readError) throw new Error(readError.message);
      assert(roomRow?.status === "closed", "member should still be able to read the closed room");
    });
  } finally {
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, member.userId, latecomer.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(member.userId);
    await admin.auth.admin.deleteUser(latecomer.userId);
  }

  console.log("");
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
