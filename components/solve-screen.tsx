"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Editor from "@monaco-editor/react";
import { SUPPORTED_LANGUAGES, isSupportedLanguage, type SupportedLanguage } from "@/lib/leetcode/languages";

const MONACO_LANGUAGE_ID: Record<SupportedLanguage, string> = {
  python3: "python",
  java: "java",
  cpp: "cpp",
  javascript: "javascript",
  go: "go",
  c: "c",
};

const LAST_LANGUAGE_KEY = "wecode:lastLanguage";

function draftKey(roomId: string, slug: string, language: SupportedLanguage) {
  return `wecode:draft:${roomId}:${slug}:${language}`;
}

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing / storage disabled — drafts just don't persist.
  }
}

type ProblemLanguage = { language: SupportedLanguage; starterCode: string | null };

type Problem = {
  questionId: string;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  content: string;
  exampleTestcases: string;
  languages: ProblemLanguage[];
};

type VerdictStatus = {
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  statusMessage: string;
  totalCorrect?: number;
  totalTestcases?: number;
  runtimeError?: string;
  lastTestcase?: string;
  expectedOutput?: string;
  codeOutput?: string;
};

type RunStatus = {
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  statusMessage: string;
  totalCorrect?: number;
  totalTestcases?: number;
  runtimeError?: string;
  codeAnswer?: string[];
  expectedCodeAnswer?: string[];
  compareResult?: string;
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

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "judging" }
  | { kind: "done"; result: RunStatus }
  | { kind: "error"; message: string };

// Epic 03 — the solo-solve screen. Fetches the real problem (Story 1),
// runs a real submission through the LeetCode judge and polls for the
// verdict (Stories 2/3), supports the launch language set (Story 4), and
// surfaces rate-limit/expired-session failures distinctly (Stories 5/6).
// Scoped to a room + slug directly — every submission is a real,
// persisted public.submissions row (see docs/SCHEMA.md's room-centric-
// rounds design).
//
// Code drafts and test cases are kept in localStorage, not the DB — they're
// per-browser scratch state, not something other room members or a
// reload-on-another-device need to see.
export function SolveScreen({ roomId, slug }: { roomId: string; slug: string }) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [language, setLanguage] = useState<SupportedLanguage>(SUPPORTED_LANGUAGES[0]);
  const [code, setCode] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [testCases, setTestCases] = useState<string[]>([]);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/rooms/${roomId}/problems/${slug}`);
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
        setTestCases([data.exampleTestcases ?? ""]);

        const languages: ProblemLanguage[] = data.languages;
        const lastLanguage = readLocalStorage(LAST_LANGUAGE_KEY);
        const preferred =
          (lastLanguage &&
            isSupportedLanguage(lastLanguage) &&
            languages.find((l) => l.language === lastLanguage)) ||
          languages.find((l) => l.starterCode) ||
          languages[0];

        setLanguage(preferred.language);
        setCode(readLocalStorage(draftKey(roomId, slug, preferred.language)) ?? preferred.starterCode ?? "");
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
  }, [roomId, slug]);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      if (runPollTimeoutRef.current) clearTimeout(runPollTimeoutRef.current);
      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    };
  }, []);

  function handleCodeChange(value: string) {
    setCode(value);

    if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    draftSaveTimeoutRef.current = setTimeout(() => {
      writeLocalStorage(draftKey(roomId, slug, language), value);
    }, 500);
  }

  function handleLanguageChange(next: SupportedLanguage) {
    setLanguage(next);
    writeLocalStorage(LAST_LANGUAGE_KEY, next);

    const draft = readLocalStorage(draftKey(roomId, slug, next));
    if (draft !== null) {
      setCode(draft);
      return;
    }

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
          roomId,
          slug,
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

  async function pollRunStatus(interpretId: string) {
    try {
      const response = await fetch(`/api/runs/${interpretId}/status`);
      const data = await response.json();

      if (response.status === 401 && data.error === "leetcode_session_stale") {
        setRunState({ kind: "error", message: "Your LeetCode session expired — reconnect and try again." });
        return;
      }

      if (!response.ok) {
        setRunState({ kind: "error", message: data.error ?? "Couldn't check run status." });
        return;
      }

      if (data.state === "SUCCESS" || data.state === "FAILURE") {
        setRunState({ kind: "done", result: data });
        return;
      }

      runPollTimeoutRef.current = setTimeout(() => pollRunStatus(interpretId), 1200);
    } catch {
      setRunState({ kind: "error", message: "Couldn't reach WeCode while running. Try again." });
    }
  }

  async function handleRun() {
    if (loadState.kind !== "ready") return;

    setRunState({ kind: "running" });

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId,
          slug,
          questionId: loadState.problem.questionId,
          language,
          code,
          dataInput: testCases.join("\n"),
        }),
      });

      const data = await response.json();

      if (response.status === 401 && data.error === "leetcode_session_stale") {
        setRunState({ kind: "error", message: "Reconnect your LeetCode account to run code." });
        return;
      }

      if (response.status === 429) {
        setRunState({ kind: "error", message: data.message ?? "Rate limited." });
        return;
      }

      if (!response.ok) {
        setRunState({ kind: "error", message: data.error ?? "Run failed." });
        return;
      }

      setRunState({ kind: "judging" });
      pollRunStatus(data.interpretId);
    } catch {
      setRunState({ kind: "error", message: "Couldn't reach WeCode. Check your connection." });
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
  const isRunning = runState.kind === "running" || runState.kind === "judging";

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

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRun}
              disabled={isRunning || isSubmitting}
              className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-white/15"
            >
              {runState.kind === "judging"
                ? "Running…"
                : runState.kind === "running"
                  ? "Running…"
                  : "Run"}
            </button>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || isRunning}
              className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-60"
            >
              {submitState.kind === "judging"
                ? "Judging…"
                : submitState.kind === "submitting"
                  ? "Submitting…"
                  : "Submit"}
            </button>
          </div>
        </div>

        <div className="min-h-[300px] flex-1 overflow-hidden rounded-md border border-black/10 dark:border-white/15">
          <Editor
            height="100%"
            language={MONACO_LANGUAGE_ID[language]}
            value={code}
            onChange={(value) => handleCodeChange(value ?? "")}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        </div>

        <TestCasePanel testCases={testCases} onChange={setTestCases} />
        <RunResult state={runState} />
        <SubmitResult state={submitState} />
      </section>
    </div>
  );
}

function TestCasePanel({
  testCases,
  onChange,
}: {
  testCases: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-zinc-500">Test cases</p>
        <button
          type="button"
          onClick={() => onChange([...testCases, ""])}
          className="text-xs text-zinc-500 underline"
        >
          Add case
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {testCases.map((testCase, index) => (
          <div key={index} className="flex items-start gap-2">
            <textarea
              value={testCase}
              onChange={(e) => {
                const next = [...testCases];
                next[index] = e.target.value;
                onChange(next);
              }}
              rows={2}
              className="flex-1 rounded-md border border-black/10 bg-transparent p-2 font-mono text-xs dark:border-white/15"
              placeholder="One input value per line"
            />
            {testCases.length > 1 ? (
              <button
                type="button"
                onClick={() => onChange(testCases.filter((_, i) => i !== index))}
                className="text-xs text-zinc-500"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunResult({ state }: { state: RunState }) {
  if (state.kind === "idle" || state.kind === "running") return null;

  if (state.kind === "error") {
    return <p className="mt-3 text-sm text-red-600 dark:text-red-400">{state.message}</p>;
  }

  if (state.kind === "judging") {
    return <p className="mt-3 text-sm text-zinc-500">Running…</p>;
  }

  const { result } = state;

  if (result.runtimeError) {
    return (
      <div className="mt-3 text-sm text-red-600 dark:text-red-400">
        <p className="font-medium">{result.statusMessage}</p>
        <p className="whitespace-pre-wrap">{result.runtimeError}</p>
      </div>
    );
  }

  // totalTestcases is authoritative — codeAnswer/expectedCodeAnswer carry
  // one extra padding entry beyond it, and compareResult (a "1"/"0" per
  // case) is the only reliable pass/fail signal LeetCode gives us here.
  const count = result.totalTestcases ?? result.compareResult?.length ?? 0;
  const cases = Array.from({ length: count }, (_, index) => ({
    output: result.codeAnswer?.[index] ?? "",
    expected: result.expectedCodeAnswer?.[index],
    passed: result.compareResult?.[index] === "1",
  }));

  return (
    <div className="mt-3 flex flex-col gap-2 text-sm">
      {cases.map(({ output, expected, passed }, index) => (
        <div
          key={index}
          className={passed ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}
        >
          <p className="font-medium">
            Case {index + 1}: {passed ? "Passed" : "Failed"}
          </p>
          <p>Output: {output}</p>
          {!passed && expected !== undefined ? <p>Expected: {expected}</p> : null}
        </div>
      ))}
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
      {verdict.lastTestcase ? (
        <div className="mt-1">
          <p>Failed on: {verdict.lastTestcase}</p>
          {verdict.expectedOutput ? <p>Expected: {verdict.expectedOutput}</p> : null}
          {verdict.codeOutput ? <p>Got: {verdict.codeOutput}</p> : null}
        </div>
      ) : null}
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
