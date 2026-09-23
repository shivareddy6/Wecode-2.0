import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../lib/supabase/database.types";

// Reconciles a real inconsistency: docs/SCHEMA.md documents removal as soft
// specifically "so chat and leaderboard history stay attributable to a real
// person even after a host kicks them," but compute_leaderboard() and
// compute_leaderboard_breakdown() both used to filter their roster to
// active (removed_at is null) participants only — a kicked user's entire
// score/breakdown history vanished, even though their submission-activity
// chat entries (Epic 07, Story 5) kept showing up. This script exercises
// the fix (leaderboard_includes_removed migration): a kicked participant's
// history stays visible in both RPCs, flagged via is_removed, exactly
// mirroring how compute_leaderboard_breakdown() already handles
// is_out_of_contest (visible, marked, never hidden). No socket server
// dependency. Self-cleaning regardless of pass/fail.

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
  const kicked = await createAuthedUser();

  await admin.from("users").insert([
    { id: host.userId, leetcode_id: `verify-host-${host.userId}`, leetcode_username: "verify-host" },
    { id: kicked.userId, leetcode_id: `verify-kicked-${kicked.userId}`, leetcode_username: "verify-kicked" },
  ]);

  const hostClient = asUser(host.accessToken);
  const { data: room, error: roomError } = await hostClient.rpc("create_room", {
    p_invite_code: `verify-${randomUUID().slice(0, 8)}`,
  });
  if (roomError || !room) throw new Error(`create_room failed: ${roomError?.message}`);
  const roomId = room.id;

  const kickedClient = asUser(kicked.accessToken);
  const { error: joinError } = await kickedClient.rpc("join_room", { p_room_id: roomId });
  if (joinError) throw new Error(`join_room failed: ${joinError.message}`);

  try {
    const { error: startError } = await hostClient.rpc("start_room_round", {
      p_room_id: roomId,
      p_problems: [{ slug: "verify-p1", title: "Verify P1", difficulty: "easy" }],
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

    // The soon-to-be-kicked participant solves the problem while still an
    // active member.
    await admin.from("submissions").insert({
      room_id: roomId,
      problem_slug: "verify-p1",
      difficulty: "easy",
      user_id: kicked.userId,
      language: "python3",
      verdict: "accepted",
      submitted_at: new Date(roundStartedAt.getTime() + 1000).toISOString(),
      judged_at: new Date(roundStartedAt.getTime() + 1000).toISOString(),
    });

    // The exact write removeParticipant makes.
    const { data: kickData, error: kickError } = await hostClient
      .from("room_participants")
      .update({ removed_at: new Date().toISOString() })
      .eq("room_id", roomId)
      .eq("user_id", kicked.userId)
      .is("removed_at", null)
      .select("user_id");
    if (kickError) throw new Error(`kick failed: ${kickError.message}`);
    assert((kickData ?? []).length === 1, "expected exactly one row to be soft-removed");

    const { data: leaderboard, error: leaderboardError } = await hostClient.rpc("compute_leaderboard", {
      p_room_id: roomId,
    });
    if (leaderboardError) throw new Error(`compute_leaderboard failed: ${leaderboardError.message}`);

    const { data: breakdown, error: breakdownError } = await hostClient.rpc(
      "compute_leaderboard_breakdown",
      { p_room_id: roomId },
    );
    if (breakdownError) throw new Error(`compute_leaderboard_breakdown failed: ${breakdownError.message}`);

    await check("kicked participant's rollup row survives, flagged is_removed", async () => {
      const row = (leaderboard ?? []).find((r) => r.user_id === kicked.userId);
      assert(!!row, "kicked participant's leaderboard row should not vanish");
      assert(row!.is_removed === true, "expected is_removed = true");
      assert(row!.total_score > 0, "expected the kicked participant's score to be preserved");
      assert(row!.problems_solved === 1, "expected problems_solved to be preserved");
    });

    await check("the active host's own rollup row is not flagged removed", async () => {
      const row = (leaderboard ?? []).find((r) => r.user_id === host.userId);
      assert(!!row, "host's leaderboard row missing");
      assert(row!.is_removed === false, "host should not be flagged as removed");
    });

    await check("kicked participant's breakdown row survives, flagged is_removed", async () => {
      const row = (breakdown ?? []).find(
        (r) => r.user_id === kicked.userId && r.problem_slug === "verify-p1",
      );
      assert(!!row, "kicked participant's breakdown row should not vanish");
      assert(row!.status === "solved", `expected solved, got ${row!.status}`);
      assert(row!.problem_score > 0, "expected the kicked participant's problem_score to be preserved");
      assert(row!.is_removed === true, "expected is_removed = true");
    });
  } finally {
    await admin.from("submissions").delete().eq("room_id", roomId);
    await admin.from("room_participants").delete().eq("room_id", roomId);
    await admin.from("rooms").delete().eq("id", roomId);
    await admin.from("users").delete().in("id", [host.userId, kicked.userId]);
    await admin.auth.admin.deleteUser(host.userId);
    await admin.auth.admin.deleteUser(kicked.userId);
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
