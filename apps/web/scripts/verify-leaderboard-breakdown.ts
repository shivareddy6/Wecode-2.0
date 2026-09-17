import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// Epic 06, Story 4 — end-to-end smoke test for compute_leaderboard_breakdown().
// Builds one round with two problems and drives four cells of the
// (participant x problem) grid the function is supposed to fill in:
// an in-contest solve after one wrong attempt, a never-attempted problem,
// an out-of-contest solve (still visible, still scored 0), and a solve
// that only exists because the accepted submission arrived after the
// round's deadline. No socket server involved — unlike Story 2's live
// push, this RPC is read on the page's own server-render cycle, not
// pushed. Self-cleaning regardless of pass/fail.

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

// Same generateLink+verifyOtp mechanism established in
// apps/socket-server/scripts/verify.ts and reused by
// verify-leaderboard-push.ts — mints a real, signature-valid access
// token for a throwaway user without touching LeetCode.
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

  try {
    const { error: startError } = await hostClient.rpc("start_room_round", {
      p_room_id: roomId,
      p_problems: [
        { slug: "verify-p1", title: "Verify P1", difficulty: "easy" },
        { slug: "verify-p2", title: "Verify P2", difficulty: "medium" },
      ],
      p_duration_seconds: 1800,
      p_preset: "warm_up",
    });
    if (startError) throw new Error(`start_room_round failed: ${startError.message}`);

    const { data: roomRow, error: roomFetchError } = await admin
      .from("rooms")
      .select("round_started_at")
      .eq("id", roomId)
      .single();
    if (roomFetchError || !roomRow?.round_started_at) {
      throw new Error(`could not read round_started_at: ${roomFetchError?.message}`);
    }
    const roundStartedAt = new Date(roomRow.round_started_at);

    // host: wrong attempt on p1, then accepted on p1 (in-contest).
    await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-p1",
      difficulty: "easy",
      user_id: host.userId,
      language: "python3",
      verdict: "wrong_answer",
      submitted_at: new Date(roundStartedAt.getTime() + 1000).toISOString(),
      judged_at: new Date(roundStartedAt.getTime() + 1000).toISOString(),
    });
    await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-p1",
      difficulty: "easy",
      user_id: host.userId,
      language: "python3",
      verdict: "accepted",
      submitted_at: new Date(roundStartedAt.getTime() + 2000).toISOString(),
      judged_at: new Date(roundStartedAt.getTime() + 2000).toISOString(),
    });
    // host: p2 never attempted.

    // participant: p1 never attempted. p2 accepted, but out-of-contest
    // (submitted after the round's deadline — flagged the same way
    // app/api/submissions/route.ts denormalizes it at insert time).
    await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-p2",
      difficulty: "medium",
      user_id: participant.userId,
      language: "python3",
      verdict: "accepted",
      is_out_of_contest: true,
      submitted_at: new Date(roundStartedAt.getTime() + 5000).toISOString(),
      judged_at: new Date(roundStartedAt.getTime() + 5000).toISOString(),
    });

    const { data: breakdown, error: breakdownError } = await participantClient.rpc(
      "compute_leaderboard_breakdown",
      { p_room_id: roomId },
    );
    if (breakdownError) throw new Error(`compute_leaderboard_breakdown failed: ${breakdownError.message}`);

    const rowFor = (userId: string, slug: string) =>
      (breakdown ?? []).find((r) => r.user_id === userId && r.problem_slug === slug);

    await check("host's solved problem scores > 0 and reflects one wrong attempt", async () => {
      const row = rowFor(host.userId, "verify-p1");
      assert(!!row, "host/p1 row missing");
      assert(row!.status === "solved", `expected solved, got ${row!.status}`);
      assert(row!.problem_score > 0, "expected positive score");
      assert(row!.attempt_count === 2, `expected 2 attempts, got ${row!.attempt_count}`);
    });

    await check("host's never-attempted problem is 0-scored and marked not_attempted", async () => {
      const row = rowFor(host.userId, "verify-p2");
      assert(!!row, "host/p2 row missing");
      assert(row!.status === "not_attempted", `expected not_attempted, got ${row!.status}`);
      assert(row!.problem_score === 0, "expected 0 score");
      assert(row!.attempt_count === 0, "expected 0 attempts");
    });

    await check("participant's out-of-contest accept is visible, marked, and scores 0", async () => {
      const row = rowFor(participant.userId, "verify-p2");
      assert(!!row, "participant/p2 row missing");
      assert(row!.status === "solved_out_of_contest", `expected solved_out_of_contest, got ${row!.status}`);
      assert(row!.problem_score === 0, "out-of-contest accept must score 0");
      assert(row!.attempt_count === 1, `expected 1 attempt, got ${row!.attempt_count}`);
    });

    await check("participant's never-attempted problem is not_attempted", async () => {
      const row = rowFor(participant.userId, "verify-p1");
      assert(!!row, "participant/p1 row missing");
      assert(row!.status === "not_attempted", `expected not_attempted, got ${row!.status}`);
    });
  } finally {
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
