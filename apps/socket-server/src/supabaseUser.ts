import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";
import { env } from "./env.js";

// A Supabase client scoped to one user's already-verified access token,
// forwarded as the Authorization header on every request. This is the
// socket-server equivalent of apps/web/lib/supabase/server.ts's
// cookie-based client — the token here arrived over the socket handshake
// instead of a cookie, but the effect is the same: PostgREST/RPC calls
// made through this client run with auth.uid() resolving to this user,
// so RLS and the is_room_member/is_room_host SECURITY DEFINER functions
// (apps/web/lib/dal.ts's verifyRoomAccess uses the same two RPCs) work
// exactly as they do for a request from the Next.js app. Never use the
// service-role client for these checks — that would bypass the ownership
// check entirely rather than perform it.
export function buildUserClient(accessToken: string) {
  return createClient<Database>(env.supabaseUrl, env.supabasePublishableKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export type UserClient = ReturnType<typeof buildUserClient>;
