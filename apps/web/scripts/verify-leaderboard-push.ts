import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../lib/supabase/database.types";

// Epic 06, Story 2 — end-to-end smoke test for the live leaderboard push.
// Exercises exactly the two calls app/api/submissions/[id]/status/route.ts
// makes after writing a final verdict (compute_leaderboard RPC, then
// a POST to the realtime server's /internal/broadcast — same request
// lib/realtime/broadcast.ts's broadcastToRoom() makes, reimplemented
// inline here rather than imported since that module is marked
// "server-only" and can't resolve outside Next's own bundler) against
// real scratch fixtures, with a real socket.io-client standing in for a
// participant's open leaderboard tab — the same protocol
// components/live-leaderboard.tsx speaks. Doesn't drive the actual
// LeetCode judging call (unchanged, pre-existing code, and needs a real
// LeetCode session); this is scoped to the new wiring only. Requires
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

// Same generateLink+verifyOtp mechanism apps/socket-server/scripts/verify.ts
// and apps/web/app/api/auth/sync/route.ts use — mints a real, signature-
// valid access token for a throwaway user without touching LeetCode.
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

// A client authenticated *as* a specific user (forwards their access
// token as the Authorization header) — the RPCs below are SECURITY
// DEFINER functions that key off auth.uid(), so calling them through the
// service-role client directly would leave auth.uid() null.
function asUser(accessToken: string) {
  return createClient<Database>(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function main() {
  console.log(`Running against realtime server at ${realtimeServerUrl}\n`);

  const host = await createAuthedUser();
  const participant = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    {
      id: participant.userId,
      leetcode_id: `verify-participant-${participant.userId}`,
      leetcode_username: "verify-participant",
    },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const participantClient = asUser(participant.accessToken);
  const { error: joinError } = await participantClient.rpc("join_room", { p_room_id: roomId });
  if (joinError) throw new Error(`join_room failed: ${joinError.message}`);

  let socket: Socket | undefined;

  try {
    // Stands in for the participant's already-open leaderboard tab —
    // same connect/room:join contract components/live-leaderboard.tsx uses.
    socket = ioClient(realtimeServerUrl, { auth: { token: participant.accessToken } });

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

    await check("participant socket joined the room channel", async () => {});

    // Insert the row the (unchanged) LeetCode-judging step would have
    // written, standing in for the "verdict just got set to accepted" moment
    // status/route.ts reacts to.
    const { error: insertError } = await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-slug",
      difficulty: "easy",
      user_id: host.userId,
      language: "python3",
      verdict: "accepted",
      judged_at: new Date().toISOString(),
    });
    if (insertError) throw new Error(`submission insert failed: ${insertError.message}`);

    const pushReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no leaderboard:update received")), 5000);
      socket!.on("leaderboard:update", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // The exact two calls status/route.ts makes after writing a final verdict.
    await check("compute_leaderboard + broadcastToRoom (the new code path)", async () => {
      const { data: rows, error } = await admin.rpc("compute_leaderboard", { p_room_id: roomId });
      if (error) throw new Error(`compute_leaderboard failed: ${error.message}`);
      await broadcastToRoom(roomId, "leaderboard:update", rows ?? []);
    });

    await check("participant's socket received the pushed leaderboard", async () => {
      const payload = (await pushReceived) as Array<{ user_id: string; total_score: number }>;
      const hostRow = payload.find((r) => r.user_id === host.userId);
      assert(!!hostRow, "host's row missing from pushed leaderboard");
      assert(hostRow!.total_score > 0, "host's score should be > 0 after an accepted solve");
    });
  } finally {
    socket?.disconnect();

    await admin.from("submissions").delete().eq("room_id", roomId);
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, participant.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(participant.userId);
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
