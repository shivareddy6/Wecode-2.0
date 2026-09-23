import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// Epic 04, Story 8 — end-to-end smoke test for transferring host powers.
// Exercises the exact DB write app/rooms/actions.ts's transferHost makes (a
// rooms.host_user_id update under RLS, host-only via the USING clause, new
// value restricted to an existing active participant via the widened WITH
// CHECK — see the transfer_host migration), then confirms the new host
// actually holds host powers and the old host doesn't. No socket server
// dependency — transferHost pushes nothing live. Self-cleaning regardless
// of pass/fail.

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
  const bystander = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    { id: member.userId, leetcode_id: `verify-member-${member.userId}`, leetcode_username: "verify-member" },
    {
      id: bystander.userId,
      leetcode_id: `verify-bystander-${bystander.userId}`,
      leetcode_username: "verify-bystander",
    },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const memberClient = asUser(member.accessToken);
  const bystanderClient = asUser(bystander.accessToken);

  const { error: memberJoinError } = await memberClient.rpc("join_room", { p_room_id: roomId });
  if (memberJoinError) throw new Error(`join_room (member) failed: ${memberJoinError.message}`);

  const { error: bystanderJoinError } = await bystanderClient.rpc("join_room", { p_room_id: roomId });
  if (bystanderJoinError) throw new Error(`join_room (bystander) failed: ${bystanderJoinError.message}`);

  try {
    await check("a non-host cannot transfer host (RLS excludes non-hosts)", async () => {
      const { data, error } = await memberClient
        .from("rooms")
        .update({ host_user_id: member.userId })
        .eq("id", roomId)
        .eq("host_user_id", host.userId)
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "a non-host update should have matched zero rows");
    });

    await check("host cannot transfer to someone who isn't an active participant", async () => {
      const outsiderId = randomUUID();
      const { error } = await hostClient
        .from("rooms")
        .update({ host_user_id: outsiderId })
        .eq("id", roomId)
        .eq("host_user_id", host.userId)
        .select("id");
      assert(!!error, "expected the widened WITH CHECK to reject a non-member target");
    });

    await check("transferHost's DB write (host hands off to an active participant)", async () => {
      const { data, error } = await hostClient
        .from("rooms")
        .update({ host_user_id: member.userId })
        .eq("id", roomId)
        .eq("host_user_id", host.userId)
        .select("id, host_user_id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be updated");
      assert(data![0]!.host_user_id === member.userId, "host_user_id should now be the new host");
    });

    await check("the new host now passes is_room_host", async () => {
      const { data, error } = await memberClient.rpc("is_room_host", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "new host should pass is_room_host");
    });

    await check("the old host no longer passes is_room_host", async () => {
      const { data, error } = await hostClient.rpc("is_room_host", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === false, "old host should no longer pass is_room_host");
    });

    await check("the old host can no longer transfer host again", async () => {
      const { data, error } = await hostClient
        .from("rooms")
        .update({ host_user_id: bystander.userId })
        .eq("id", roomId)
        .eq("host_user_id", host.userId)
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "old host's update should match zero rows");
    });

    await check("the new host actually holds host powers (can close the room)", async () => {
      const { data, error } = await memberClient
        .from("rooms")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", roomId)
        .eq("status", "open")
        .select("id, status");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "new host should be able to close the room");
      assert(data![0]!.status === "closed", "room should now be closed");
    });

    await check("the outgoing host kept their own room_participants row untouched", async () => {
      const { data, error } = await admin
        .from("room_participants")
        .select("removed_at")
        .eq("room_id", roomId)
        .eq("user_id", host.userId)
        .single();
      if (error) throw new Error(error.message);
      assert(data?.removed_at === null, "outgoing host should still be an active participant");
    });

    await check("bystander is unaffected", async () => {
      const { data, error } = await bystanderClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "bystander should still be a member");
    });
  } finally {
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, member.userId, bystander.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(member.userId);
    await admin.auth.admin.deleteUser(bystander.userId);
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
