"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

// How often to pull fresh round state from the server while a round is
// active — the only way another participant's browser learns the host
// ended the round early: there's no Epic 11 push yet, so this is a
// periodic router.refresh() instead of a live event. ~5s is "immediately
// enough" for a friends-group contest without standing up sockets just
// for this; true instant delivery is what Epic 11 would give up front.
const LIVE_REFRESH_INTERVAL_MS = 5000;

// A minimal "has this component mounted on the client yet" store — used
// only to know when it's safe to start showing a live-clock value without
// a hydration mismatch. getSnapshot/getServerSnapshot each always return
// the same fixed primitive (true / false), which is what useSyncExternalStore
// actually requires: its contract is "return a *stable* value until the
// store itself notifies a change," not "return whatever's current right
// now." An earlier version of this file tried to hand the hook Date.now()
// directly as the snapshot — which changes on literally every call — and
// React correctly rejected that with an infinite-loop guard at runtime.
// This mounted-flag pattern is the standard, lint-clean way to gate a
// legitimately-different-on-the-client value: React handles the
// server-to-client swap itself (no manual setState-on-mount needed).
function subscribeOnce() {
  return () => {};
}
function getMountedSnapshot() {
  return true;
}
function getServerMountedSnapshot() {
  return false;
}

// Epic 05, Story 3/6 — client-computed from the server-authoritative
// round_started_at/round_duration_seconds already on the room row, not a
// server push: every participant's clock independently lands on the same
// deadline instant without needing Epic 11's realtime infrastructure for
// the *countdown math* itself. Ending a round early, though, changes
// round_status out from under a viewer who already loaded the page —
// nothing about that page load will ever ask again unless something
// tells it to, which is what the periodic refresh() below is for.
export function RoundCountdown({
  roundStartedAt,
  roundDurationSeconds,
  roundStatus,
}: {
  roundStartedAt: string | null;
  roundDurationSeconds: number | null;
  roundStatus: "active" | "ended" | null;
}) {
  const router = useRouter();
  const deadline =
    roundStartedAt && roundDurationSeconds
      ? new Date(roundStartedAt).getTime() + roundDurationSeconds * 1000
      : null;

  const hasMounted = useSyncExternalStore(subscribeOnce, getMountedSnapshot, getServerMountedSnapshot);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null || roundStatus !== "active") return;

    // setNow is only ever called from inside these callbacks, never
    // synchronously as the effect's first statement — the latter is what
    // trips react-hooks' "avoid cascading renders" rule, and would also
    // just be redundant here: hasMounted flipping true already forces the
    // one extra render this component needs post-hydration.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const liveRefresh = setInterval(() => router.refresh(), LIVE_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(tick);
      clearInterval(liveRefresh);
    };
  }, [deadline, roundStatus, router]);

  if (deadline === null) return null;

  // Same "unknown yet" output on the server and the pre-mount client pass
  // — a placeholder that later changes is fine; one that *disagrees*
  // between server and pre-mount client is the actual bug being avoided.
  // Briefly shown again right after mount too, until the first tick above
  // fires (up to ~1s) — a trivial cosmetic gap, not a correctness issue.
  if (!hasMounted || now === null) {
    return <p className="text-sm font-medium text-zinc-400">…</p>;
  }

  const remainingMs = deadline - now;
  const isOver = roundStatus !== "active" || remainingMs <= 0;

  if (isOver) {
    return <p className="text-sm font-medium text-red-600 dark:text-red-400">Round ended</p>;
  }

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return (
    <p className="text-sm font-medium">
      {minutes}:{seconds.toString().padStart(2, "0")} remaining
    </p>
  );
}
