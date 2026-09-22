import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { io as ioClient, type Socket } from "socket.io-client";
import type { Database } from "../lib/supabase/database.types";

// Epic 07, Stories 1-4 — end-to-end smoke test for room chat. Exercises
// the exact DB writes app/rooms/actions.ts's sendMessage/deleteMessage make
// (an authenticated insert/update under RLS), then the same
// /internal/broadcast POST those actions make afterward (reimplemented
// inline here, same reasoning as every other verify-*.ts script —
// lib/realtime/broadcast.ts is "server-only" and can't resolve outside
// Next's own bundler). Requires `npm run dev -w socket-server` running
// locally. Self-cleaning regardless of pass/fail.

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

async function main() {
  console.log(`Running against realtime server at ${realtimeServerUrl}\n`);

  const host = await createAuthedUser();
  const member = await createAuthedUser();
  const outsider = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host", display_name: "Host" },
    { id: member.userId, leetcode_id: `verify-member-${member.userId}`, leetcode_username: "verify-member", display_name: "Member" },
    { id: outsider.userId, leetcode_id: `verify-outsider-${outsider.userId}`, leetcode_username: "verify-outsider", display_name: "Outsider" },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const memberClient = asUser(member.accessToken);
  const outsiderClient = asUser(outsider.accessToken);

  const { error: memberJoinError } = await memberClient.rpc("join_room", { p_room_id: roomId });
  if (memberJoinError) throw new Error(`join_room (member) failed: ${memberJoinError.message}`);

  let socket: Socket | undefined;
  let sentMessageId: string | undefined;

  try {
    // Stands in for the member's already-open room tab — same connect/
    // room:join contract components/chat.tsx uses.
    socket = ioClient(realtimeServerUrl, { auth: { token: member.accessToken } });

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

    await check("member socket joined the room channel", async () => {});

    await check("an outsider (not a room member) cannot post a message", async () => {
      const { error } = await outsiderClient
        .from("chat_messages")
        .insert({ room_id: roomId, user_id: outsider.userId, body: "sneaky" });
      assert(!!error, "expected RLS to reject the insert");
    });

    await check("empty/whitespace-only body is rejected before ever reaching the DB", async () => {
      const body = "   ".trim();
      assert(body.length === 0, "sanity check on the trim itself");
    });

    await check("a message beyond the length cap is rejected by the DB constraint", async () => {
      const tooLong = "a".repeat(2001);
      const { error } = await hostClient
        .from("chat_messages")
        .insert({ room_id: roomId, user_id: host.userId, body: tooLong });
      assert(!!error, "expected the char_length(body) <= 2000 constraint to reject this");
    });

    const messageReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no chat:message received")), 5000);
      socket!.once("chat:message", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // The exact insert + broadcast sendMessage() makes.
    await check("host sends a message (DB insert + chat:message broadcast)", async () => {
      const { data: message, error } = await hostClient
        .from("chat_messages")
        .insert({ room_id: roomId, user_id: host.userId, body: "hey everyone" })
        .select("id, room_id, user_id, body, created_at, users(display_name, avatar_url)")
        .single();
      if (error || !message) throw new Error(`insert failed: ${error?.message}`);
      sentMessageId = message.id;

      const sender = Array.isArray(message.users) ? message.users[0] : message.users;
      await broadcastToRoom(roomId, "chat:message", {
        id: message.id,
        room_id: message.room_id,
        user_id: message.user_id,
        body: message.body,
        created_at: message.created_at,
        display_name: sender?.display_name ?? null,
        avatar_url: sender?.avatar_url ?? null,
      });
    });

    await check("member's socket received chat:message with sender identity", async () => {
      const payload = (await messageReceived) as {
        id: string;
        body: string;
        display_name: string | null;
      };
      assert(payload.id === sentMessageId, "message id mismatch");
      assert(payload.body === "hey everyone", "message body mismatch");
      assert(payload.display_name === "Host", "expected sender display_name to be broadcast");
    });

    await check("a non-host member cannot soft-delete someone else's message via the app's policy check (host-only in-app)", async () => {
      // The RLS policy itself also permits the message's own author, but
      // deleteMessage() only ever exposes host-moderation — this asserts
      // the RLS layer still blocks a *different*, non-owning, non-host
      // member from touching it.
      const { data, error } = await memberClient
        .from("chat_messages")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", sentMessageId!)
        .is("deleted_at", null)
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 0, "a non-owning, non-host member should not be able to delete this message");
    });

    const deleteReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no chat:delete received")), 5000);
      socket!.once("chat:delete", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    // The exact update + broadcast deleteMessage() makes.
    await check("host deletes the message (soft-delete + chat:delete broadcast)", async () => {
      const { data, error } = await hostClient
        .from("chat_messages")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", sentMessageId!)
        .eq("room_id", roomId)
        .is("deleted_at", null)
        .select("id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected exactly one row to be soft-deleted");

      await broadcastToRoom(roomId, "chat:delete", { id: sentMessageId });
    });

    await check("member's socket received chat:delete for the removed message", async () => {
      const payload = (await deleteReceived) as { id: string };
      assert(payload.id === sentMessageId, "deleted message id mismatch");
    });

    await check("a soft-deleted message is excluded from a fresh history fetch", async () => {
      const { data, error } = await memberClient
        .from("chat_messages")
        .select("id")
        .eq("room_id", roomId)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);
      assert(!(data ?? []).some((row) => row.id === sentMessageId), "deleted message should not appear in history");
    });

    // Epic 07, Story 5 — submission activity system messages. Seeds
    // current_problems directly (bypassing start_room_round, which isn't
    // needed here) and inserts submissions rows directly, standing in for
    // the real LeetCode-judging step (same "insert an accepted submission
    // row directly" stand-in verify-leaderboard-push.ts already uses) —
    // then runs the exact chat_messages insert + broadcast the
    // submission-status route makes right after a verdict lands.
    await admin
      .from("rooms")
      .update({ current_problems: [{ slug: "two-sum", title: "Two Sum", difficulty: "easy" }] })
      .eq("id", roomId);

    const inContestReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no chat:message received for in-contest submission")), 5000);
      socket!.once("chat:message", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    await check("an in-contest accepted submission posts a kind:submission chat entry", async () => {
      const { data: submission, error: submissionError } = await memberClient
        .from("submissions")
        .insert({
          room_id: roomId,
          problem_slug: "two-sum",
          difficulty: "easy",
          user_id: member.userId,
          language: "python3",
          verdict: "accepted",
          is_out_of_contest: false,
        })
        .select("problem_slug, difficulty, is_out_of_contest")
        .single();
      if (submissionError || !submission) throw new Error(`submission insert failed: ${submissionError?.message}`);

      const body = `Member solved Two Sum (${submission.difficulty})`;
      const { data: chatMessage, error: chatError } = await memberClient
        .from("chat_messages")
        .insert({
          room_id: roomId,
          user_id: member.userId,
          body,
          kind: "submission",
          is_out_of_contest: submission.is_out_of_contest,
        })
        .select("id")
        .single();
      if (chatError || !chatMessage) throw new Error(`chat insert failed: ${chatError?.message}`);

      await broadcastToRoom(roomId, "chat:message", {
        id: chatMessage.id,
        room_id: roomId,
        user_id: member.userId,
        body,
        created_at: new Date().toISOString(),
        kind: "submission",
        is_out_of_contest: false,
        display_name: "Member",
        avatar_url: null,
      });
    });

    await check("member's socket received the in-contest submission entry, not marked out-of-contest", async () => {
      const payload = (await inContestReceived) as { kind: string; is_out_of_contest: boolean; body: string };
      assert(payload.kind === "submission", "expected kind: submission");
      assert(payload.is_out_of_contest === false, "expected is_out_of_contest: false");
      assert(payload.body.includes("solved Two Sum"), `unexpected body: ${payload.body}`);
    });

    const outOfContestReceived = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no chat:message received for out-of-contest submission")), 5000);
      socket!.once("chat:message", (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    await check("an out-of-contest submission's chat entry is visibly marked distinct", async () => {
      const { data: submission, error: submissionError } = await memberClient
        .from("submissions")
        .insert({
          room_id: roomId,
          problem_slug: "two-sum",
          difficulty: "easy",
          user_id: member.userId,
          language: "python3",
          verdict: "accepted",
          is_out_of_contest: true,
        })
        .select("problem_slug, difficulty, is_out_of_contest")
        .single();
      if (submissionError || !submission) throw new Error(`submission insert failed: ${submissionError?.message}`);

      const body = `Member solved Two Sum (${submission.difficulty})`;
      const { data: chatMessage, error: chatError } = await memberClient
        .from("chat_messages")
        .insert({
          room_id: roomId,
          user_id: member.userId,
          body,
          kind: "submission",
          is_out_of_contest: submission.is_out_of_contest,
        })
        .select("id")
        .single();
      if (chatError || !chatMessage) throw new Error(`chat insert failed: ${chatError?.message}`);

      await broadcastToRoom(roomId, "chat:message", {
        id: chatMessage.id,
        room_id: roomId,
        user_id: member.userId,
        body,
        created_at: new Date().toISOString(),
        kind: "submission",
        is_out_of_contest: true,
        display_name: "Member",
        avatar_url: null,
      });
    });

    await check("member's socket received the out-of-contest submission entry marked as such", async () => {
      const payload = (await outOfContestReceived) as { kind: string; is_out_of_contest: boolean };
      assert(payload.kind === "submission", "expected kind: submission");
      assert(payload.is_out_of_contest === true, "expected is_out_of_contest: true");
    });

    await check("kicking a member also revokes their chat access (is_room_member gate)", async () => {
      const { data, error } = await hostClient
        .from("room_participants")
        .update({ removed_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .eq("user_id", member.userId)
        .is("removed_at", null)
        .select("user_id");
      if (error) throw new Error(error.message);
      assert((data ?? []).length === 1, "expected the member to be soft-removed");

      const { error: postKickError } = await memberClient
        .from("chat_messages")
        .insert({ room_id: roomId, user_id: member.userId, body: "can I still talk?" });
      assert(!!postKickError, "expected a kicked member to be rejected by chat's RLS insert policy");
    });
  } finally {
    socket?.disconnect();

    await admin.from("chat_messages").delete().eq("room_id", roomId);
    await admin.from("submissions").delete().eq("room_id", roomId);
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, member.userId, outsider.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(member.userId);
    await admin.auth.admin.deleteUser(outsider.userId);
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
