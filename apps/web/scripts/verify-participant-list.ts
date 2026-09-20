import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../lib/supabase/database.types";

// Epic 04, Story 3 — end-to-end smoke test for the live participant list.
// Exercises the same shape app/rooms/actions.ts's joinRoom/removeParticipant
// use: join_room()/a removed_at update, then a roster re-fetch + POST to
// the realtime server's /internal/broadcast (reimplemented inline here,
// same reasoning as verify-leaderboard-push.ts and
// verify-kick-participant.ts — lib/realtime/broadcast.ts is "server-only").
// Also asserts join_room()'s real-insert-vs-no-op return value directly,
// since that's what actions.ts gates the broadcast on. Requires
// `npm run dev -w socket-server` running locally. Self-cleaning regardless
// of pass/fail.

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

async function broadcastToRoom(roomId: string, event: string, payload: unknown): Promise<void> {
  const response = await fetch(`${realtimeServerUrl}/internal/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": realtimeInternalSecret },
    body: JSON.stringify({ roomId, event, payload }),
  });
  if (!response.ok) throw new Error(`broadcast responded ${response.status}`);
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

async function fetchRoster(roomId: string): Promise<Array<{ user_id: string; display_name: string | null }>> {
  const { data } = await admin
    .from("room_participants")
    .select("user_id, users(display_name)")
    .eq("room_id", roomId)
    .is("removed_at", null);

  return (data ?? []).map((row) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    return { user_id: row.user_id, display_name: user?.display_name ?? null };
  });
}

async function main() {
  console.log(`Running against realtime server at ${realtimeServerUrl}\n`);

  const host = await createAuthedUser();
  const joiner = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    { id: joiner.userId, leetcode_id: `verify-joiner-${joiner.userId}`, leetcode_username: "verify-joiner" },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const joinerClient = asUser(joiner.accessToken);

  let socket: Socket | undefined;

  try {
    // Stands in for the host's already-open room tab — same connect/
    // room:join contract components/participant-list.tsx uses.
    socket = ioClient(realtimeServerUrl, { auth: { token: host.accessToken } });

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

    await check("host socket joined the room channel", async () => {});

    const joinUpdateReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no participants:update received")), 5000);
      socket!.once("participants:update", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    await check("join_room() returns true for a real first-time join", async () => {
      const { data: didJoin, error } = await joinerClient.rpc("join_room", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(didJoin === true, "expected join_room to report a real insert");

      // The exact follow-up joinRoom() makes when didJoin is true.
      await broadcastToRoom(roomId, "participants:update", await fetchRoster(roomId));
    });

    await check("host's socket received participants:update with both members", async () => {
      const payload = (await joinUpdateReceived) as Array<{ user_id: string; display_name: string | null }>;
      assert(payload.length === 2, `expected 2 rows, got ${payload.length}`);
      assert(payload.some((r) => r.user_id === joiner.userId), "joiner missing from roster push");
      assert(payload.some((r) => r.user_id === host.userId), "host missing from roster push");
    });

    await check("join_room() returns false for the ordinary already-a-member no-op", async () => {
      const { data: didJoin, error } = await joinerClient.rpc("join_room", { p_room_id: roomId });
      if (error) throw new Error(error.message);
      assert(didJoin === false, "expected join_room to report no insert on a repeat call");
    });

    const kickUpdateReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no participants:update received after kick")), 5000);
      socket!.once("participants:update", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    await check("removeParticipant's DB write + roster rebroadcast", async () => {
      const { data, error } = await hostClient
        .from("room_participants")
        .update({ removed_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .eq("user_id", joiner.userId)
        .is("removed_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be soft-removed");

      // The exact follow-up removeParticipant() makes after the DB write
      // (disconnectUserFromRoom is covered by verify-kick-participant.ts).
      await broadcastToRoom(roomId, "participants:update", await fetchRoster(roomId));
    });

    await check("host's socket received participants:update with the kicked member gone", async () => {
      const payload = (await kickUpdateReceived) as Array<{ user_id: string; display_name: string | null }>;
      assert(payload.length === 1, `expected 1 row, got ${payload.length}`);
      assert(payload[0]!.user_id === host.userId, "only the host should remain");
    });
  } finally {
    socket?.disconnect();

    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, joiner.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(joiner.userId);
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
