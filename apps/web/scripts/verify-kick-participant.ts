import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../lib/supabase/database.types";

// Epic 04, Story 4 — end-to-end smoke test for kicking a participant.
// Exercises the same two calls apps/web/app/rooms/actions.ts's
// removeParticipant makes (a room_participants.removed_at update under
// RLS, then a POST to the realtime server's /internal/disconnect —
// reimplemented inline here rather than imported since
// lib/realtime/broadcast.ts is marked "server-only" and can't resolve
// outside Next's own bundler, same reasoning as verify-leaderboard-push.ts),
// plus the join_room() rejoin-block added alongside it. Requires
// `npm run dev -w socket-server` running locally. Self-cleaning
// regardless of pass/fail.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const realtimeServerUrl = requiredEnv("REALTIME_SERVER_URL");
const realtimeInternalSecret = requiredEnv("REALTIME_INTERNAL_SECRET");

async function disconnectUserFromRoom(roomId: string, userId: string): Promise<void> {
  const response = await fetch(`${realtimeServerUrl}/internal/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": realtimeInternalSecret },
    body: JSON.stringify({ roomId, userId }),
  });
  if (!response.ok) throw new Error(`disconnect responded ${response.status}`);
}

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

// Same generateLink+verifyOtp mechanism verify-leaderboard-push.ts uses —
// mints a real, signature-valid access token for a throwaway user without
// touching LeetCode.
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
  console.log(`Running against realtime server at ${realtimeServerUrl}\n`);

  const host = await createAuthedUser();
  const kicked = await createAuthedUser();
  const bystander = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    { id: kicked.userId, leetcode_id: `verify-kicked-${kicked.userId}`, leetcode_username: "verify-kicked" },
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

  const kickedClient = asUser(kicked.accessToken);
  const bystanderClient = asUser(bystander.accessToken);

  const { error: kickedJoinError } = await kickedClient.rpc("join_room", { p_room_id: roomId });
  if (kickedJoinError) throw new Error(`join_room (kicked) failed: ${kickedJoinError.message}`);

  const { error: bystanderJoinError } = await bystanderClient.rpc("join_room", { p_room_id: roomId });
  if (bystanderJoinError) throw new Error(`join_room (bystander) failed: ${bystanderJoinError.message}`);

  let socket: Socket | undefined;

  try {
    // Stands in for the kicked participant's already-open tab (e.g. the
    // leaderboard page) — same connect/room:join contract
    // components/live-leaderboard.tsx uses.
    socket = ioClient(realtimeServerUrl, { auth: { token: kicked.accessToken } });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("connect timed out")), 5000);
      socket!.on("connect_error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      socket!.on("connect", () => {
        socket!.emit("room:join", { roomId }, (ack: { ok: boolean; reason?: string }) => {
          clearTimeout(timeout);
          if (!ack.ok) reject(new Error(`room:join rejected: ${ack.reason}`));
          else resolve();
        });
      });
    });

    await check("kicked participant's socket joined the room channel", async () => {});

    await check("host cannot remove themself (RLS excludes the host row)", async () => {
      const { data, error } = await hostClient
        .from("room_participants")
        .update({ removed_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .eq("user_id", host.userId)
        .is("removed_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "host row should not have been updatable");
    });

    const kickedEventReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no room:kicked received")), 5000);
      socket!.on("room:kicked", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // The exact two calls removeParticipant makes.
    await check("removeParticipant's DB write (host removes the kicked participant)", async () => {
      const { data, error } = await hostClient
        .from("room_participants")
        .update({ removed_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .eq("user_id", kicked.userId)
        .is("removed_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be soft-removed");

      await disconnectUserFromRoom(roomId, kicked.userId);
    });

    await check("kicked participant's socket received room:kicked", async () => {
      await kickedEventReceived;
    });

    await check("kicked participant no longer counts as a room member", async () => {
      const { data, error } = await kickedClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === false, "is_room_member should be false after removal");
    });

    await check("kicked participant cannot rejoin via the invite link", async () => {
      const { error } = await kickedClient.rpc("join_room", { p_room_id: roomId });
      assert(!!error, "expected join_room to reject a removed participant");
      assert(
        (error?.message ?? "").includes("removed"),
        `expected a "removed" error, got: ${error?.message}`,
      );
    });

    await check("bystander is unaffected", async () => {
      const { data, error } = await bystanderClient.rpc("is_room_member", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(data === true, "bystander should still be a member");
    });
  } finally {
    socket?.disconnect();

    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, kicked.userId, bystander.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(kicked.userId);
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
