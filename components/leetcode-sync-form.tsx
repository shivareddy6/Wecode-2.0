"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Epic 01, Story 5 — manual credential entry. Posts to the same
// /api/auth/sync endpoint the browser extension will use (Epic 02); this
// form is just one of two front-ends over that one flow.
export function LeetCodeSyncForm() {
  const router = useRouter();
  const [session, setSession] = useState("");
  const [csrf, setCsrf] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const response = await fetch("/api/auth/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leetcodeSession: session.trim(),
          csrfToken: csrf.trim(),
          syncedVia: "manual",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setError(data.error ?? "Sync failed. Try again.");
        return;
      }

      router.refresh();
    } catch {
      setStatus("error");
      setError("Couldn't reach WeCode. Check your connection and try again.");
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full max-w-md flex-col gap-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="leetcode-session" className="text-sm font-medium">
          LEETCODE_SESSION
        </label>
        <input
          id="leetcode-session"
          value={session}
          onChange={(e) => setSession(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          className="rounded-md border border-black/[.1] bg-transparent px-3 py-2 font-mono text-sm dark:border-white/[.15]"
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          On leetcode.com, open DevTools → Application/Storage → Cookies →
          leetcode.com, and copy the value of the{" "}
          <code className="font-mono">LEETCODE_SESSION</code> cookie.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="csrf-token" className="text-sm font-medium">
          csrftoken
        </label>
        <input
          id="csrf-token"
          value={csrf}
          onChange={(e) => setCsrf(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          className="rounded-md border border-black/[.1] bg-transparent px-3 py-2 font-mono text-sm dark:border-white/[.15]"
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Same place, the <code className="font-mono">csrftoken</code>{" "}
          cookie.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="flex h-11 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
      >
        {status === "submitting" ? "Syncing…" : "Sync"}
      </button>
    </form>
  );
}
