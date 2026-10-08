"use client";

import { useState } from "react";
import { LeetCodeSyncForm } from "@/components/leetcode-sync-form";

// An already-authenticated visitor's LEETCODE_SESSION can still go stale
// on LeetCode's own end, independent of their WeCode/Supabase auth state
// — but the landing page only ever showed the sync form to signed-out
// visitors, leaving no UI path to re-sync once signed in. /api/auth/sync
// is the same endpoint for a first connect and a re-sync (see its own
// header comment), so reusing the same form here is just exposing an
// already-supported call, not new backend behavior.
export function ReconnectLeetCode() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-muted underline">
        Reconnect LeetCode
      </button>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <LeetCodeSyncForm />
      <button type="button" onClick={() => setOpen(false)} className="self-center text-xs text-muted underline">
        Cancel
      </button>
    </div>
  );
}
