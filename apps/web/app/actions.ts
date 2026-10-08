"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Root-level, not room-scoped — WeCode had no sign-out path anywhere
// before this (the landing page only ever branched on auth state, never
// offered to leave it). Ends the Supabase Auth session; the LeetCode
// session itself (encrypted in user_credentials) is untouched — signing
// back in with the same account resumes it rather than needing a fresh
// sync, unless it's independently gone stale on LeetCode's end.
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
