import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../lib/supabase/database.types";

// Epic 11, Story 5 — end-to-end smoke test for the reconnect-refetch
// pattern added to LiveLeaderboard/ParticipantList/Chat (apps/web/
// components/*.tsx): on the initial connect, do nothing extra (the SSR'd
// initial props already cover it); on every *subsequent* connect (a real
// reconnect), re-fetch current state directly rather than trusting that
// no broadcast was missed while disconnected.
//
// This can't literally mount the React components (no browser/login
// harness in this environment — see AGENTS.md-style project convention
// of testing against real Supabase data, not React unit tests), so it
// reimplements the exact same connect-handler shape as a plain
// socket.io-client script, the same way verify-kick-participant.ts
// reimplements disconnectUserFromRoom inline rather than importing a
// "server-only" module. What this proves: a mutation made directly
// against Postgres *without* going through broadcastToRoom (simulating a
// missed push while disconnected) is still picked up once the client
// reconnects and re-fetches — the actual point of Story 5's AC. Forces a
// real reconnect (not a clean client-initiated disconnect, which
// socket.io-client won't auto-retry) via engine.close(), the standard way
// to simulate an abrupt network drop. Self-cleaning regardless of
// pass/fail.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const realtimeServerUrl = requiredEnv("REALTIME_SERVER_URL");

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

function waitForEvent<T>(socket: Socket, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.on(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function main() {
  console.log(`Running against realtime server at ${realtimeServerUrl}\n`);

  const host = await createAuthedUser();

  await admin
    .from("users")
    .insert([{ id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" }]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const { error: startError } = await hostClient.rpc("start_room_round", {
    p_room_id: roomId,
    p_problems: [{ slug: "verify-p1", title: "Verify P1", difficulty: "easy" }],
    p_duration_seconds: 1800,
    p_preset: "warm_up",
  });
  if (startError) throw new Error(`start_room_round failed: ${startError.message}`);

  let socket: Socket | undefined;
  // Mirrors the components' `hasConnectedBefore` ref exactly.
  let hasConnectedBefore = false;
  let latestLeaderboard: unknown[] = [];

  try {
    socket = ioClient(realtimeServerUrl, { auth: { token: host.accessToken } });

    socket.on("connect", () => {
      socket!.emit("room:join", { roomId });

      if (hasConnectedBefore) {
        void hostClient.rpc("compute_leaderboard", { p_room_id: roomId }).then(({ data }) => {
          if (data) latestLeaderboard = data;
        });
      }
      hasConnectedBefore = true;
    });

    await waitForEvent(socket, "connect", 5000);

    await check("initial connect does not need a refetch (SSR already covers it)", async () => {
      // Nothing to assert beyond "no crash" — this connect intentionally
      // skips the refetch branch, matching the components' own logic.
    });

    // Simulate a push that gets missed entirely: mutate Postgres directly,
    // bypassing broadcastToRoom, the way a real Accepted verdict would
    // trigger app/api/submissions/[id]/status/route.ts's recompute+push —
    // except here nothing tells the socket layer about it at all.
    await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-p1",
      difficulty: "easy",
      user_id: host.userId,
      language: "python3",
      verdict: "accepted",
      submitted_at: new Date().toISOString(),
      judged_at: new Date().toISOString(),
    });

    const reconnectPromise = waitForEvent(socket, "connect", 15000);
    // Forces an abrupt, non-client-initiated disconnect — socket.io's
    // built-in reconnection only retries automatically for this kind of
    // drop, not for a manual socket.disconnect() call.
    (socket.io.engine as unknown as { close: () => void }).close();

    await check("the socket actually reconnects after an abrupt drop", async () => {
      await reconnectPromise;
    });

    // Give the reconnect handler's async refetch a moment to resolve.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await check("reconnecting re-fetches current state and picks up the missed mutation", async () => {
      const row = (latestLeaderboard as { user_id: string; total_score: number }[]).find(
        (r) => r.user_id === host.userId,
      );
      assert(!!row, "expected the host's row in the re-fetched leaderboard");
      assert(row!.total_score > 0, "expected the missed submission's score to show up via the refetch");
    });
  } finally {
    socket?.disconnect();
    await admin.from("submissions").delete().eq("room_id", roomId);
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().eq("id", host.userId);
    await admin.auth.admin.deleteUser(host.userId);
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
