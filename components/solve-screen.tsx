"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Editor from "@monaco-editor/react";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/lib/leetcode/languages";

const MONACO_LANGUAGE_ID: Record<SupportedLanguage, string> = {
  python3: "python",
  java: "java",
  cpp: "cpp",
  javascript: "javascript",
  go: "go",
  c: "c",
};

type ProblemLanguage = { language: SupportedLanguage; starterCode: string | null };

type Problem = {
  questionId: string;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  content: string;
  languages: ProblemLanguage[];
};

type VerdictStatus = {
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  statusMessage: string;
  totalCorrect?: number;
  totalTestcases?: number;
  runtimeError?: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "stale" }
  | { kind: "error"; message: string }
  | { kind: "ready"; problem: Problem };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "judging" }
  | { kind: "done"; verdict: VerdictStatus }
  | { kind: "error"; message: string; retryAfterSeconds?: number };

// Epic 03 — the solo-solve screen. Fetches the real problem (Story 1),
// runs a real submission through the LeetCode judge and polls for the
// verdict (Stories 2/3), supports the launch language set (Story 4), and
// surfaces rate-limit/expired-session failures distinctly (Stories 5/6).
// Scoped to a real session_problem — every submission is a real,
// persisted public.submissions row (see the room/session pivot).
export function SolveScreen({ sessionProblemId }: { sessionProblemId: string }) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [language, setLanguage] = useState<SupportedLanguage>(SUPPORTED_LANGUAGES[0]);
  const [code, setCode] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/session-problems/${sessionProblemId}`);
        const data = await response.json();
        if (cancelled) return;

        if (response.status === 401 && data.error === "leetcode_session_stale") {
          setLoadState({ kind: "stale" });
          return;
        }

        if (!response.ok) {
          setLoadState({ kind: "error", message: data.error ?? "Couldn't load this problem." });
          return;
        }

        setLoadState({ kind: "ready", problem: data });

        const languages: ProblemLanguage[] = data.languages;
        const preferred = languages.find((l) => l.starterCode) ?? languages[0];
        setLanguage(preferred.language);
        setCode(preferred.starterCode ?? "");
      } catch {
        if (!cancelled) {
          setLoadState({ kind: "error", message: "Couldn't reach WeCode. Check your connection." });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionProblemId]);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  function handleLanguageChange(next: SupportedLanguage) {
    setLanguage(next);
    if (loadState.kind === "ready") {
      const starter = loadState.problem.languages.find((l) => l.language === next)?.starterCode;
      setCode(starter ?? "");
    }
  }

  async function pollStatus(submissionId: string) {
    try {
      const response = await fetch(`/api/submissions/${submissionId}/status`);
      const data = await response.json();

      if (response.status === 401 && data.error === "leetcode_session_stale") {
        setSubmitState({
          kind: "error",
          message: "Your LeetCode session expired mid-submission — reconnect and try again.",
        });
        return;
      }

      if (!response.ok) {
        setSubmitState({ kind: "error", message: data.error ?? "Couldn't check your submission." });
        return;
      }

      if (data.state === "SUCCESS" || data.state === "FAILURE") {
        setSubmitState({ kind: "done", verdict: data });
        return;
      }

      pollTimeoutRef.current = setTimeout(() => pollStatus(submissionId), 1500);
    } catch {
      setSubmitState({ kind: "error", message: "Couldn't reach WeCode while judging. Try again." });
    }
  }

  async function handleSubmit() {
    if (loadState.kind !== "ready") return;

    setSubmitState({ kind: "submitting" });

    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionProblemId,
          questionId: loadState.problem.questionId,
          language,
          code,
        }),
      });

      const data = await response.json();

      if (response.status === 401 && data.error === "leetcode_session_stale") {
        setSubmitState({ kind: "error", message: "Reconnect your LeetCode account to submit." });
        return;
      }

      if (response.status === 429) {
        setSubmitState({
          kind: "error",
          message: data.message ?? "Rate limited.",
          retryAfterSeconds: data.retryAfterSeconds,
        });
        return;
      }

      if (!response.ok) {
        setSubmitState({ kind: "error", message: data.error ?? "Submission failed." });
        return;
      }

      setSubmitState({ kind: "judging" });
      pollStatus(data.submissionId);
    } catch {
      setSubmitState({ kind: "error", message: "Couldn't reach WeCode. Check your connection." });
    }
  }

  if (loadState.kind === "loading") {
    return <Centered>Loading problem…</Centered>;
  }

  if (loadState.kind === "stale") {
    return (
      <Centered>
        <p>Your LeetCode session has expired.</p>
        <Link href="/" className="underline">
          Reconnect on the home page
        </Link>
      </Centered>
    );
  }

  if (loadState.kind === "error") {
    return <Centered>{loadState.message}</Centered>;
  }

  const { problem } = loadState;
  const isSubmitting = submitState.kind === "submitting" || submitState.kind === "judging";

  return (
    <div className="flex h-screen flex-col md:flex-row">
      <section className="flex-1 overflow-y-auto border-b border-black/10 p-6 dark:border-white/10 md:border-b-0 md:border-r">
        <h1 className="text-xl font-semibold">{problem.title}</h1>
        <p className="mb-4 text-sm text-zinc-500">{problem.difficulty}</p>
        {/* LeetCode's own problem HTML, from LeetCode's API — a trusted
            source, not user-generated content. */}
        <div
          className="text-sm leading-relaxed [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-100 [&_pre]:p-3 dark:[&_pre]:bg-zinc-900"
          dangerouslySetInnerHTML={{ __html: problem.content }}
        />
      </section>

      <section className="flex flex-1 flex-col p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as SupportedLanguage)}
            className="rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm dark:border-white/15"
          >
            {problem.languages.map((l) => (
              <option key={l.language} value={l.language}>
                {l.language}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-60"
          >
            {submitState.kind === "judging"
              ? "Judging…"
              : submitState.kind === "submitting"
                ? "Submitting…"
                : "Submit"}
          </button>
        </div>

        <div className="min-h-[300px] flex-1 overflow-hidden rounded-md border border-black/10 dark:border-white/15">
          <Editor
            height="100%"
            language={MONACO_LANGUAGE_ID[language]}
            value={code}
            onChange={(value) => setCode(value ?? "")}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        </div>

        <SubmitResult state={submitState} />
      </section>
    </div>
  );
}

function SubmitResult({ state }: { state: SubmitState }) {
  if (state.kind === "idle" || state.kind === "submitting") return null;

  if (state.kind === "judging") {
    return <p className="mt-3 text-sm text-zinc-500">Judging…</p>;
  }

  if (state.kind === "error") {
    return (
      <p className="mt-3 text-sm text-red-600 dark:text-red-400">
        {state.message}
        {state.retryAfterSeconds ? ` (${state.retryAfterSeconds}s)` : null}
      </p>
    );
  }

  const { verdict } = state;
  const isAccepted = verdict.state === "SUCCESS" && verdict.statusMessage === "Accepted";

  return (
    <div
      className={`mt-3 text-sm ${isAccepted ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
    >
      <p className="font-medium">{verdict.statusMessage}</p>
      {verdict.totalTestcases ? (
        <p>
          {verdict.totalCorrect ?? 0} / {verdict.totalTestcases} testcases passed
        </p>
      ) : null}
      {verdict.runtimeError ? <p className="whitespace-pre-wrap">{verdict.runtimeError}</p> : null}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 text-center text-sm text-zinc-600 dark:text-zinc-400">
      {children}
    </div>
  );
}
