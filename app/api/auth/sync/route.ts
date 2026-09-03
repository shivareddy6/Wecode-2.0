import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchLeetCodeIdentity } from "@/lib/leetcode/client";
import { encrypt } from "@/lib/crypto";

// The one sync endpoint both the manual-paste form (Epic 01, Story 5) and
// the browser extension (Epic 02) POST to — same body shape, same code
// path, no separate account type. See ARCHITECTURE.md's "Identity & Auth"
// section for the full flow this implements.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { leetcodeSession, csrfToken, syncedVia } = (body ?? {}) as Record<
    string,
    unknown
  >;

  // Catches empty/truncated pastes before spending a round trip on
  // LeetCode (Epic 01, Story 5) — not a full format validator, since the
  // real check is whether LeetCode accepts these values at all, next.
  if (
    typeof leetcodeSession !== "string" ||
    typeof csrfToken !== "string" ||
    leetcodeSession.trim().length < 20 ||
    csrfToken.trim().length < 20
  ) {
    return NextResponse.json(
      {
        error:
          "Session and CSRF token look empty or truncated — re-copy both values.",
      },
      { status: 400 },
    );
  }

  const session = leetcodeSession.trim();
  const csrf = csrfToken.trim();
  const via = syncedVia === "extension" ? "extension" : "manual";

  let identity;
  try {
    identity = await fetchLeetCodeIdentity({ session, csrf });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach LeetCode to verify that session. Try again in a moment." },
      { status: 502 },
    );
  }

  if (!identity) {
    return NextResponse.json(
      { error: "That session/CSRF pair isn't currently signed in on LeetCode." },
      { status: 401 },
    );
  }

  // From here on, the only identity ever acted on is identity.userId — the
  // one LeetCode's own live API just returned for these exact credentials,
  // never anything client-supplied. That's the explicit ownership check
  // this service-role path needs in place of RLS (Epic 01, Story 7 /
  // ARCHITECTURE.md's DAL section).
  const admin = createAdminClient();
  const email = `lc-${identity.userId}@users.wecode.internal`;

  const { data: existingUser, error: lookupError } = await admin
    .from("users")
    .select("id")
    .eq("leetcode_id", identity.userId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json(
      { error: "Couldn't look up your account. Try again." },
      { status: 500 },
    );
  }

  // generateLink's `magiclink` type provisions the underlying Supabase Auth
  // user if one doesn't exist yet (same as a passwordless sign-in would) and
  // reuses it otherwise — one call covers both Story 1 (create) and Story 2
  // (log in), and no password is ever set on the account (Story 6).
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  if (linkError || !link) {
    return NextResponse.json(
      { error: "Couldn't provision your account. Try again." },
      { status: 500 },
    );
  }

  const userId = link.user.id;

  if (existingUser) {
    const { error: updateError } = await admin
      .from("users")
      .update({
        leetcode_username: identity.username,
        display_name: identity.username,
        avatar_url: identity.avatar,
      })
      .eq("id", userId);

    if (updateError) {
      return NextResponse.json(
        { error: "Couldn't update your account. Try again." },
        { status: 500 },
      );
    }
  } else {
    const { error: insertError } = await admin.from("users").insert({
      id: userId,
      leetcode_id: identity.userId,
      leetcode_username: identity.username,
      display_name: identity.username,
      avatar_url: identity.avatar,
    });

    if (insertError) {
      return NextResponse.json(
        { error: "Couldn't create your account. Try again." },
        { status: 500 },
      );
    }
  }

  const { error: credentialsError } = await admin
    .from("user_credentials")
    .upsert({
      user_id: userId,
      leetcode_session_ciphertext: encrypt(session),
      leetcode_csrf_ciphertext: encrypt(csrf),
      synced_via: via,
      session_status: "valid",
      updated_at: new Date().toISOString(),
    });

  if (credentialsError) {
    return NextResponse.json(
      { error: "Couldn't store your credentials. Try again." },
      { status: 500 },
    );
  }

  // Redeem the magic-link token server-side so the request-scoped client's
  // cookie adapter writes a real Supabase session onto this response — no
  // email is ever actually sent.
  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "email",
  });

  if (verifyError) {
    return NextResponse.json(
      { error: "Couldn't start your session. Try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    user: {
      leetcodeUsername: identity.username,
      avatarUrl: identity.avatar,
    },
  });
}
