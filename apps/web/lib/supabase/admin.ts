import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

// Service-role client: bypasses RLS entirely. Only for the specific paths
// ARCHITECTURE.md's "Authorization & Data Access Layer" section calls out
// as needing it — LeetCode-sync account provisioning (here) and the
// submission-proxy's credential lookup (Epic 03). Each such path carries
// its own explicit ownership/identity check in place of RLS; this client
// has none built in, so never reach for it from a path that hasn't done
// that check itself.
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
