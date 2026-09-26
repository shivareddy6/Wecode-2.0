// Epic 08, Story 5 — smoke test for the submission-proxy failure-spike
// logger (apps/web/lib/monitoring/proxy-failures.ts). No Supabase/DB
// involved — this is pure in-process logic, so unlike every other
// verify:* script here, there's nothing to seed or clean up. Sets a tiny
// window/threshold via env vars before importing the module (config() is
// read fresh on every call specifically so this works without a dynamic
// re-import).

process.env.PROXY_FAILURE_SPIKE_WINDOW_MS = "1000";
process.env.PROXY_FAILURE_SPIKE_THRESHOLD = "3";

import { recordProxyFailure, __resetProxyFailureTrackingForTests } from "../lib/monitoring/proxy-failures";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok  - ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail });
    console.log(`FAIL  - ${name}: ${detail}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function captureConsoleError(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

async function main() {
  await check("every individual failure is logged, even below the spike threshold", () => {
    __resetProxyFailureTrackingForTests();
    const lines = captureConsoleError(() => recordProxyFailure("submit", "boom"));
    assert(
      lines.some((l) => l.includes("[submission-proxy] submit failure: boom")),
      "expected the per-failure log line",
    );
    assert(!lines.some((l) => l.includes("ALERT")), "should not alert on a single failure (threshold is 3)");
  });

  await check("no ALERT line until the threshold is actually crossed", () => {
    __resetProxyFailureTrackingForTests();
    const lines = captureConsoleError(() => {
      recordProxyFailure("submit", "one");
      recordProxyFailure("submit", "two");
    });
    assert(!lines.some((l) => l.includes("ALERT")), "2 failures should not yet cross a threshold of 3");
  });

  await check("crossing the threshold within the window fires an ALERT line", () => {
    __resetProxyFailureTrackingForTests();
    const lines = captureConsoleError(() => {
      recordProxyFailure("submit", "one");
      recordProxyFailure("submit", "two");
      recordProxyFailure("check-status", "three");
    });
    const alertLine = lines.find((l) => l.includes("ALERT"));
    assert(!!alertLine, "expected an ALERT line on the 3rd failure within the window");
    assert(alertLine!.includes("3 failures"), `expected the count in the alert, got: ${alertLine}`);
    assert(alertLine!.includes("check-status"), "expected the most recent failure's context in the alert");
  });

  await check("failures outside the rolling window don't count toward a new spike", async () => {
    __resetProxyFailureTrackingForTests();
    recordProxyFailure("submit", "one");
    recordProxyFailure("submit", "two");
    // Window is 1000ms — wait it out so these two age out before the next ones land.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const lines = captureConsoleError(() => {
      recordProxyFailure("submit", "three");
    });
    assert(
      !lines.some((l) => l.includes("ALERT")),
      "the first two failures should have aged out of the window by now",
    );
  });

  console.log("");
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
