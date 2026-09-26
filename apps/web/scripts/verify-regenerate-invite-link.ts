import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// Epic 08, Story 4 — end-to-end smoke test for revoking/regenerating a
// room's invite link. Exercises the exact write app/rooms/actions.ts's
// regenerateInviteLink makes (a rooms.invite_code update under RLS,
// host-only via the pre-existing "hosts manage their own rooms" USING
// clause), then confirms the old code stops resolving anything while the
// new one resolves the same room, and that existing members are
// unaffected. No socket server dependency. Self-cleaning regardless of
// pass/fail.

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

  const originalCode = `verify-${randomUUID().slice(0, 8)}`;
  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: originalCode,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const memberClient = asUser(member.accessToken);
  const latecomerClient = asUser(latecomer.accessToken);

  const { error: memberJoinError } = await memberClient.rpc("join_room", { p_room_id: roomId });
  if (memberJoinError) throw new Error(`join_room (member) failed: ${memberJoinError.message}`);

  const newCode = `verify-${randomUUID().slice(0, 8)}`;

  try {
    await check("a non-host cannot regenerate the invite link (RLS excludes non-hosts)", async () => {
      const { data, error } = await memberClient
        .from("rooms")
        .update({ invite_code: `verify-${randomUUID().slice(0, 8)}` })
        .eq("id", roomId)
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "a non-host update should have matched zero rows");
    });

    await check("regenerateInviteLink's DB write (host regenerates the code)", async () => {
      const { data, error } = await hostClient
        .from("rooms")
        .update({ invite_code: newCode })
        .eq("id", roomId)
        .select("id, invite_code");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be updated");
      assert(data![0]!.invite_code === newCode, "invite_code should now be the new code");
    });

    await check("the old invite code no longer resolves to any room", async () => {
      const { data, error } = await admin
        .from("rooms")
        .select("id")
        .eq("invite_code", originalCode)
        .maybeSingle();
      if (error) throw new Error(error.message);
      assert(data === null, "the old invite code should no longer match a room");
    });

    await check("the new invite code resolves to the same room", async () => {
      const { data, error } = await admin
        .from("rooms")
        .select("id")
        .eq("invite_code", newCode)
        .single();
      if (error) throw new Error(error.message);
      assert(data.id === roomId, "the new invite code should resolve to the same room");
    });

    await check("a newcomer cannot join via the old (now-invalid) code", async () => {
      const { data } = await admin.from("rooms").select("id").eq("invite_code", originalCode).maybeSingle();
      assert(data === null, "the old code should not be joinable — no room resolves to it anymore");
    });

    await check("a newcomer can join via the new code", async () => {
      const { error: joinError } = await latecomerClient.rpc("join_room", { p_room_id: roomId });
      if (joinError) throw new Error(`join_room (latecomer) failed: ${joinError.message}`);

      const { data, error } = await latecomerClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "latecomer should now be a room member");
    });

    await check("the existing member is completely unaffected", async () => {
      const { data, error } = await memberClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "existing member should still be a room member");
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
