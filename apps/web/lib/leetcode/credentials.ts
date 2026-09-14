import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { fetchLeetCodeIdentity, type LeetCodeCredentials } from "@/lib/leetcode/client";

// A transient failure talking to LeetCode (network blip, rate limit,
// momentary Cloudflare challenge) — distinct from "not signed in." Callers
// should surface a "try again" response, not treat this as a stale
// session.
export class LeetCodeUnavailableError extends Error {
  constructor() {
    super("Couldn't reach LeetCode to verify the session.");
  }
}

async function decryptStoredCredentials(
  userId: string,
): Promise<LeetCodeCredentials | null> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("user_credentials")
    .select("leetcode_session_ciphertext, leetcode_csrf_ciphertext, session_status")
    .eq("user_id", userId)
    .maybeSingle();

  if (
    !row ||
    row.session_status === "stale" ||
    !row.leetcode_session_ciphertext ||
    !row.leetcode_csrf_ciphertext
  ) {
    return null;
  }

  return {
    session: decrypt(row.leetcode_session_ciphertext),
    csrf: decrypt(row.leetcode_csrf_ciphertext),
  };
}

// Decrypt-only, no live LeetCode call — for callers that are about to
// make their own LeetCode request anyway (the status-poll route) and
// don't need a separate live "are you still signed in" round trip on
// every single poll tick. A dead session surfaces naturally when that
// request itself fails.
export async function getDecryptedLeetCodeCredentials(
  userId: string,
): Promise<LeetCodeCredentials | null> {
  return decryptStoredCredentials(userId);
}

// The one place that gets a user's decrypted, live-validated LeetCode
// session. Bypasses RLS via the admin client, so — per ARCHITECTURE.md's
// DAL section — the explicit ownership check here is that userId must
// already be the caller's own verified session id (from lib/dal.ts's
// verifySession()), never anything client-supplied. This also doubles as
// Epic 01 Story 3's stale-session detection: a session that no longer
// validates against LeetCode gets flipped to session_status = 'stale'
// right here, the first place that's ever actually discoverable.
//
// Throws LeetCodeUnavailableError (rather than returning null) when the
// live check itself fails to reach LeetCode — a transient failure isn't
// the same evidence as LeetCode actively saying "not signed in," so it
// must not flip a perfectly good session to stale.
export async function getValidLeetCodeCredentials(
  userId: string,
): Promise<LeetCodeCredentials | null> {
  const credentials = await decryptStoredCredentials(userId);

  if (!credentials) {
    return null;
  }

  let identity;
  try {
    identity = await fetchLeetCodeIdentity(credentials);
  } catch {
    throw new LeetCodeUnavailableError();
  }

  if (!identity) {
    const admin = createAdminClient();
    await admin
      .from("user_credentials")
      .update({ session_status: "stale" })
      .eq("user_id", userId);
    return null;
  }

  return credentials;
}

// Called after a submission-proxy call fails with LeetCode's own
// mid-request auth-rejection signal (LeetCodeSessionExpiredError) rather
// than the pre-flight check above catching it — same outcome, different
// trigger point.
export async function markLeetCodeSessionStale(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("user_credentials")
    .update({ session_status: "stale" })
    .eq("user_id", userId);
}
