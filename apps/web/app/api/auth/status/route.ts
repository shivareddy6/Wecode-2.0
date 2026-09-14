import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Public, unauthenticated-safe status check — distinct from the DAL's
// verifySession()/getCurrentUser(), which redirect when there's no user.
// The extension popup (Epic 02, Story 3) polls this on open to show
// Not connected / Connected as <username> / Needs resync without that
// redirect getting in the way.
export async function GET() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();

  if (!auth.user) {
    return NextResponse.json({ connected: false });
  }

  const { data: row } = await supabase
    .from("users")
    .select("leetcode_username, user_credentials(session_status)")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ connected: false });
  }

  const credentials = Array.isArray(row.user_credentials)
    ? row.user_credentials[0]
    : row.user_credentials;

  return NextResponse.json({
    connected: true,
    username: row.leetcode_username,
    sessionStatus: credentials?.session_status ?? "valid",
  });
}
