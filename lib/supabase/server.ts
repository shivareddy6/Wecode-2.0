import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "./database.types";

// One client per request, reading/writing the Supabase session cookie
// directly — this is what verifySession() in lib/dal.ts calls into.
// See ARCHITECTURE.md's "Identity & Auth" and "Authorization & Data
// Access Layer" sections for why this exists instead of a bespoke
// session/JWT setup.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component render, where cookies() is
            // read-only. Safe to ignore as long as proxy.ts refreshes the
            // session on the next request — see proxy.ts.
          }
        },
      },
    },
  );
}
