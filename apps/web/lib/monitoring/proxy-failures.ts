// Epic 08, Story 5 — "a spike in submission-proxy failures triggers a
// visible alert/log entry the developer will actually see." No external
// alerting service (Sentry, a Slack webhook, etc.) is wired into this
// project, so this is deliberately the cheapest thing that satisfies the
// AC: every failure is logged individually (console.error, visible in
// Vercel's function logs, which the developer already has access to),
// and a distinct louder "ALERT" line fires once failures cross a
// threshold within a rolling window.
//
// This tracks in a module-level array, not a table — genuinely
// per-process/per-instance, so on a multi-instance serverless deploy a
// spike spread evenly across instances could go under-detected. Accepted
// deliberately: every individual failure is still logged regardless of
// spike detection, and this project's actual scale (a friends-group tool)
// doesn't warrant a dedicated table + writes on every failure just for
// alerting. Threshold/window are env-configurable, not hardcoded, per the
// project's usual "constants configurable without a code change" pattern
// (see scoring_config).
// Read fresh on every call, not cached at module load — lets
// verify-failure-spike-alert.ts exercise a short window/threshold via
// env vars without needing a dynamic re-import.
function config() {
  return {
    windowMs: Number(process.env.PROXY_FAILURE_SPIKE_WINDOW_MS ?? 5 * 60 * 1000),
    threshold: Number(process.env.PROXY_FAILURE_SPIKE_THRESHOLD ?? 5),
  };
}

let failureTimestamps: number[] = [];

export function recordProxyFailure(context: string, detail: string): void {
  console.error(`[submission-proxy] ${context} failure: ${detail}`);

  const { windowMs, threshold } = config();
  const now = Date.now();
  failureTimestamps.push(now);
  failureTimestamps = failureTimestamps.filter((timestamp) => now - timestamp <= windowMs);

  if (failureTimestamps.length >= threshold) {
    console.error(
      `ALERT: submission-proxy failure spike — ${failureTimestamps.length} failures in the last ${Math.round(windowMs / 1000)}s (most recent: ${context})`,
    );
  }
}

// Test-only — isolates verify-failure-spike-alert.ts's checks from each
// other and from whatever ran earlier in the same process.
export function __resetProxyFailureTrackingForTests(): void {
  failureTimestamps = [];
}
