import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../src/database.types.js";
import { env } from "../src/env.js";

// End-to-end smoke test for Epic 11 (Stories 1-4, 6). No UI consumer
// exists yet, so this is the test: create throwaway fixtures via the
// service-role key, drive a real socket.io-client against a running
// `npm run dev -w socket-server` instance, assert every AC, then delete
// everything it created regardless of pass/fail.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var for verify script: ${name}`);
  }
  return value;
}

const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const baseUrl = `http://localhost:${env.port}`;

const admin = createClient<Database>(env.supabaseUrl, serviceRoleKey, {
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

// Mints a real, signature-valid Supabase access token for a throwaway
// user — the same generateLink + verifyOtp mechanism
// apps/web/app/api/auth/sync/route.ts uses for the LeetCode-sync login
// flow, minus the LeetCode round trip.
async function createAuthedUser(): Promise<{ userId: string; accessToken: string }> {
  const email = `verify-${randomUUID()}@users.wecode.internal`;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link) {
    throw new Error(`generateLink failed: ${linkError?.message}`);
  }
  const userId = link.user.id;

  const anon = createClient<Database>(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });
  if (verifyError || !verified.session) {
    throw new Error(`verifyOtp failed: ${verifyError?.message}`);
  }

  const { error: insertError } = await admin.from("users").insert({
    id: userId,
    leetcode_id: `verify-${userId}`,
    leetcode_username: "verify-user",
  });
  if (insertError) {
    throw new Error(`users insert failed: ${insertError.message}`);
  }

  return { userId, accessToken: verified.session.access_token };
}

async function createHostOnlyUser(): Promise<{ userId: string }> {
  const email = `verify-host-${randomUUID()}@users.wecode.internal`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createUser failed: ${error?.message}`);
  }
  const userId = data.user.id;

  const { error: insertError } = await admin.from("users").insert({
    id: userId,
    leetcode_id: `verify-host-${userId}`,
    leetcode_username: "verify-host",
  });
  if (insertError) {
    throw new Error(`users insert failed: ${insertError.message}`);
  }

  return { userId };
}

async function createRoom(hostUserId: string): Promise<string> {
  const { data, error } = await admin
    .from("rooms")
    .insert({
      host_user_id: hostUserId,
      invite_code: randomUUID().slice(0, 8),
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`room insert failed: ${error?.message}`);
  }
  return data.id;
}

async function addParticipant(roomId: string, userId: string) {
  const { error } = await admin.from("room_participants").insert({
    room_id: roomId,
    user_id: userId,
  });
  if (error) {
    throw new Error(`room_participants insert failed: ${error.message}`);
  }
}

function connectSocket(auth?: { token: string }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth,
      reconnection: false,
      forceNew: true,
      timeout: 5000,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

function expectConnectRejected(auth?: { token: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth,
      reconnection: false,
      forceNew: true,
      timeout: 5000,
    });
    socket.once("connect", () => {
      socket.disconnect();
      reject(new Error("expected connection to be rejected, but it succeeded"));
    });
    socket.once("connect_error", () => {
      socket.disconnect();
      resolve();
    });
  });
}

function joinRoom(socket: Socket, roomId: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room:join ack timed out")), 5000);
    socket.emit("room:join", { roomId }, (res: { ok: boolean; reason?: string }) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitForEvent(socket: Socket, event: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function didNotReceiveEvent(socket: Socket, event: string, waitMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    socket.once(event, () => {
      clearTimeout(timer);
      reject(new Error(`expected no "${event}" event, but one arrived`));
    });
  });
}

async function main() {
  console.log(`Running verify against ${baseUrl}\n`);

  const member = await createAuthedUser();
  const host = await createHostOnlyUser();
  const memberRoomId = await createRoom(host.userId);
  const otherRoomId = await createRoom(host.userId);
  await addParticipant(memberRoomId, member.userId);

  let memberSocket: Socket | undefined;

  try {
    await check("connection with no token is rejected", () => expectConnectRejected());

    await check("connection with a garbage token is rejected", () =>
      expectConnectRejected({ token: "not.a.valid.jwt" }),
    );

    await check("connection with a valid token is accepted", async () => {
      memberSocket = await connectSocket({ token: member.accessToken });
    });

    await check("room:join for a room the user is NOT in is rejected", async () => {
      assert(!!memberSocket, "no socket connected");
      const ack = await joinRoom(memberSocket!, otherRoomId);
      assert(ack.ok === false, `expected ok:false, got ${JSON.stringify(ack)}`);
    });

    await check("room:join for a room the user IS in succeeds", async () => {
      assert(!!memberSocket, "no socket connected");
      const ack = await joinRoom(memberSocket!, memberRoomId);
      assert(ack.ok === true, `expected ok:true, got ${JSON.stringify(ack)}`);
    });

    await check("POST /internal/broadcast with wrong secret is rejected", async () => {
      const res = await fetch(`${baseUrl}/internal/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": "wrong-secret" },
        body: JSON.stringify({ roomId: memberRoomId, event: "test:event", payload: { hello: "world" } }),
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    });

    await check("POST /internal/broadcast delivers the event to the joined socket", async () => {
      assert(!!memberSocket, "no socket connected");
      const eventPromise = waitForEvent(memberSocket!, "test:event");
      const res = await fetch(`${baseUrl}/internal/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": env.internalSecret },
        body: JSON.stringify({ roomId: memberRoomId, event: "test:event", payload: { hello: "world" } }),
      });
      assert(res.ok, `broadcast request failed: ${res.status}`);
      const payload = await eventPromise;
      assert(
        JSON.stringify(payload) === JSON.stringify({ hello: "world" }),
        `unexpected payload: ${JSON.stringify(payload)}`,
      );
    });

    await check("POST /internal/disconnect kicks the socket and removes it from the room", async () => {
      assert(!!memberSocket, "no socket connected");
      const kickedPromise = waitForEvent(memberSocket!, "room:kicked");
      const res = await fetch(`${baseUrl}/internal/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": env.internalSecret },
        body: JSON.stringify({ roomId: memberRoomId, userId: member.userId }),
      });
      assert(res.ok, `disconnect request failed: ${res.status}`);
      await kickedPromise;

      // Confirm removal by broadcasting again and expecting silence.
      const silence = didNotReceiveEvent(memberSocket!, "test:event", 1000);
      await fetch(`${baseUrl}/internal/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": env.internalSecret },
        body: JSON.stringify({ roomId: memberRoomId, event: "test:event", payload: {} }),
      });
      await silence;
    });
  } finally {
    memberSocket?.disconnect();
    await admin.auth.admin.deleteUser(member.userId).catch(() => {});
    await admin.auth.admin.deleteUser(host.userId).catch(() => {});
  }

  console.log("");
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
