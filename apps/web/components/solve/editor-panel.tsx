"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
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
const BOTTOM_PANEL_DEFAULT_SIZE = 38;

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

export type LoadedProblem = {
  questionId: string;
  title: string;
  difficulty: "Easy" | "Medium" | "Hard";
  content: string;
  exampleTestcases: string;
  // One entry per function parameter, in order — lets the Test Result
  // panel label each line of a case's raw input ("coins =", "amount =")
  // instead of showing an unlabeled blob. Empty when LeetCode's metaData
  // didn't parse; callers fall back to showing the raw lines unlabeled.
  paramNames: string[];
  languages: ProblemLanguage[];
};

// A case's raw input is just paramNames.length consecutive lines of the
// textcase box — same layout LeetCode's own dataInput uses, case after
// case with no separator. Caller passes however many lines the total
// input actually has; a case beyond the end gets back an empty array.
function getCaseInputLines(rawInput: string, paramNames: string[], caseIndex: number): string[] {
  const paramCount = paramNames.length || 1;
  const lines = rawInput.split("\n");
  return lines.slice(caseIndex * paramCount, caseIndex * paramCount + paramCount);
}

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
  // One combined stream for the whole run, not one entry per case — see
  // the matching comment on LeetCodeInterpretStatus.
  codeOutput?: string;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "judging"; outOfContest: boolean }
  | { kind: "done"; verdict: VerdictStatus; outOfContest: boolean }
  | { kind: "error"; message: string; retryAfterSeconds?: number };

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "judging" }
  // input is whatever was in the testcase box at the moment Run was
  // clicked — kept alongside the result so the Input shown for a case
  // always matches what actually produced it, even if the box gets
  // edited again before the run finishes.
  | { kind: "done"; result: RunStatus; input: string }
  | { kind: "error"; message: string };

type BottomTab = "testcase" | "result" | "submission";

// The solve workspace's per-problem pane: editor + the collapsible
// Testcase/Test Result/Submission panel underneath it. One of these mounts
// per problem in the round (SolveWorkspace keeps all opened ones mounted,
// toggling visibility via `isActive` rather than unmounting) so switching
// tabs never loses an in-flight run/submit or a mid-typed draft.
export function EditorPanel({
  roomId,
  slug,
  problem,
  isActive,
  roundStatus,
  onSubmissionResolved,
  onToggleSidePanel,
  onOpenLeaderboard,
}: {
  roomId: string;
  slug: string;
  problem: LoadedProblem;
  isActive: boolean;
  roundStatus: "active" | "ended" | null;
  onSubmissionResolved: (slug: string, accepted: boolean) => void;
  onToggleSidePanel: () => void;
  onOpenLeaderboard: () => void;
}) {
  const [language, setLanguage] = useState<SupportedLanguage>(() => {
    const lastLanguage = readLocalStorage(LAST_LANGUAGE_KEY);
    const preferred =
      (lastLanguage &&
        isSupportedLanguage(lastLanguage) &&
        problem.languages.find((l) => l.language === lastLanguage)) ||
      problem.languages.find((l) => l.starterCode) ||
      problem.languages[0];
    return preferred.language;
  });
  const [code, setCode] = useState(() => {
    const initialLanguage =
      (isSupportedLanguage(readLocalStorage(LAST_LANGUAGE_KEY) ?? "") &&
        readLocalStorage(LAST_LANGUAGE_KEY)) ||
      language;
    return (
      readLocalStorage(draftKey(roomId, slug, initialLanguage as SupportedLanguage)) ??
      problem.languages.find((l) => l.language === initialLanguage)?.starterCode ??
      ""
    );
  });
  const [testCaseInput, setTestCaseInput] = useState(problem.exampleTestcases ?? "");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [bottomTab, setBottomTab] = useState<BottomTab>("testcase");

  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomPanelRef = useRef<ImperativePanelHandle>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      if (runPollTimeoutRef.current) clearTimeout(runPollTimeoutRef.current);
      if (draftSaveTimeoutRef.current) clearTimeout(draftSaveTimeoutRef.current);
    };
  }, []);

  // Monaco misses the resize when its container goes from display:none to
  // visible (no size change is observed while hidden) — nudge it once this
  // pane actually becomes the visible one.
  useEffect(() => {
    if (isActive) editorRef.current?.layout();
  }, [isActive]);

  function ensureBottomPanelOpen() {
    const panel = bottomPanelRef.current;
    if (panel && panel.isCollapsed()) {
      panel.resize(BOTTOM_PANEL_DEFAULT_SIZE);
    }
  }

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
    setCode(problem.languages.find((l) => l.language === next)?.starterCode ?? "");
  }

  async function pollStatus(submissionId: string, outOfContest: boolean) {
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
        setSubmitState({ kind: "done", verdict: data, outOfContest });
        onSubmissionResolved(slug, data.state === "SUCCESS" && data.statusMessage === "Accepted");
        return;
      }

      pollTimeoutRef.current = setTimeout(() => pollStatus(submissionId, outOfContest), 1500);
    } catch {
      setSubmitState({ kind: "error", message: "Couldn't reach WeCode while judging. Try again." });
    }
  }

  async function handleSubmit() {
    setBottomTab("submission");
    ensureBottomPanelOpen();
    setSubmitState({ kind: "submitting" });

    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, slug, questionId: problem.questionId, language, code }),
      });
      const data = await response.json();

      if (response.status === 401 && data.error === "leetcode_session_stale") {
        setSubmitState({ kind: "error", message: "Reconnect your LeetCode account to submit." });
        return;
      }
      if (response.status === 429) {
        setSubmitState({ kind: "error", message: data.message ?? "Rate limited.", retryAfterSeconds: data.retryAfterSeconds });
        return;
      }
      if (!response.ok) {
        setSubmitState({ kind: "error", message: data.error ?? "Submission failed." });
        return;
      }

      const outOfContest = Boolean(data.outOfContest);
      setSubmitState({ kind: "judging", outOfContest });
      pollStatus(data.submissionId, outOfContest);
    } catch {
      setSubmitState({ kind: "error", message: "Couldn't reach WeCode. Check your connection." });
    }
  }

  async function pollRunStatus(interpretId: string, input: string) {
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
        setRunState({ kind: "done", result: data, input });
        return;
      }

      runPollTimeoutRef.current = setTimeout(() => pollRunStatus(interpretId, input), 1200);
    } catch {
      setRunState({ kind: "error", message: "Couldn't reach WeCode while running. Try again." });
    }
  }

  async function handleRun() {
    setBottomTab("result");
    ensureBottomPanelOpen();
    setRunState({ kind: "running" });
    const input = testCaseInput;

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, slug, questionId: problem.questionId, language, code, dataInput: input }),
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
      pollRunStatus(data.interpretId, input);
    } catch {
      setRunState({ kind: "error", message: "Couldn't reach WeCode. Check your connection." });
    }
  }

  const isSubmitting = submitState.kind === "submitting" || submitState.kind === "judging";
  const isRunning = runState.kind === "running" || runState.kind === "judging";

  // Monaco's own keybinding service swallows keydown events for keys it
  // handles before they ever bubble to `window` — so the plain window
  // listener below never fires while the editor itself has focus. The
  // commands registered in onMount cover that case directly through
  // Monaco's own API; both read through this ref (rather than closing
  // over isRunning/isSubmitting/etc. directly) because onMount only runs
  // once per editor instance, so a plain closure there would go stale.
  const latestRef = useRef({ handleRun, handleSubmit, isRunning, isSubmitting, onToggleSidePanel, onOpenLeaderboard });
  latestRef.current = { handleRun, handleSubmit, isRunning, isSubmitting, onToggleSidePanel, onOpenLeaderboard };

  useEffect(() => {
    if (!isActive) return;

    function handleKeydown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;

      if (event.key === "'") {
        event.preventDefault();
        if (!isRunning && !isSubmitting) void handleRun();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (!isSubmitting && !isRunning) void handleSubmit();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        const panel = bottomPanelRef.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.resize(BOTTOM_PANEL_DEFAULT_SIZE);
        else panel.collapse();
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isRunning, isSubmitting, code, language, testCaseInput]);

  return (
    <div className="flex h-full flex-col" style={{ display: isActive ? "flex" : "none" }}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <select
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value as SupportedLanguage)}
          className="rounded-md border border-border bg-panel px-2 py-1 text-sm"
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
            title="Run (⌘')"
            className="rounded-full border border-border px-4 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {isRunning ? "Running…" : "Run"}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || isRunning}
            title="Submit (⌘⏎)"
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-60"
          >
            {submitState.kind === "judging" ? "Judging…" : submitState.kind === "submitting" ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>

      <PanelGroup direction="vertical" className="flex-1">
        <Panel defaultSize={100 - BOTTOM_PANEL_DEFAULT_SIZE} minSize={30}>
          <Editor
            height="100%"
            language={MONACO_LANGUAGE_ID[language]}
            value={code}
            onChange={(value) => handleCodeChange(value ?? "")}
            onMount={(editor, monaco) => {
              editorRef.current = editor;

              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                const latest = latestRef.current;
                if (!latest.isRunning && !latest.isSubmitting) void latest.handleSubmit();
              });
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Quote, () => {
                const latest = latestRef.current;
                if (!latest.isRunning && !latest.isSubmitting) void latest.handleRun();
              });
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => {
                const panel = bottomPanelRef.current;
                if (!panel) return;
                if (panel.isCollapsed()) panel.resize(BOTTOM_PANEL_DEFAULT_SIZE);
                else panel.collapse();
              });
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
                latestRef.current.onToggleSidePanel();
              });
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyL, () => {
                latestRef.current.onOpenLeaderboard();
              });
            }}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
          />
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        <Panel
          ref={bottomPanelRef}
          defaultSize={BOTTOM_PANEL_DEFAULT_SIZE}
          minSize={15}
          collapsedSize={6}
          collapsible
          className="flex flex-col bg-panel"
        >
          <div className="flex shrink-0 gap-4 border-b border-border px-3 text-sm">
            {(
              [
                ["testcase", "Testcase"],
                ["result", "Test Result"],
                ["submission", "Submission"],
              ] as [BottomTab, string][]
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setBottomTab(tab);
                  ensureBottomPanelOpen();
                }}
                className={`border-b-2 py-2 font-medium transition-colors ${
                  bottomTab === tab ? "border-accent text-foreground" : "border-transparent text-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {bottomTab === "testcase" ? (
              <TestCasePanel value={testCaseInput} sampleTestcases={problem.exampleTestcases ?? ""} onChange={setTestCaseInput} />
            ) : bottomTab === "result" ? (
              <TestResultView state={runState} paramNames={problem.paramNames} />
            ) : (
              <SubmissionView state={submitState} />
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function TestCasePanel({
  value,
  sampleTestcases,
  onChange,
}: {
  value: string;
  sampleTestcases: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button type="button" onClick={() => onChange(sampleTestcases)} className="text-xs text-muted underline">
          Reset to sample
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        className="w-full flex-1 rounded-md border border-border bg-panel-raised p-2 font-mono text-xs"
        placeholder="One input value per line"
      />
    </div>
  );
}

function ErrorBox({ title, message }: { title?: string; message: string }) {
  return (
    <div className="rounded-md bg-danger-bg p-3 text-sm text-danger">
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <p className="whitespace-pre-wrap font-mono text-xs">{message}</p>
    </div>
  );
}

function TestResultView({ state, paramNames }: { state: RunState; paramNames: string[] }) {
  const [activeCase, setActiveCase] = useState(0);

  if (state.kind === "idle") return <p className="text-sm text-muted">You must run your code first.</p>;
  if (state.kind === "running" || state.kind === "judging") return <p className="text-sm text-muted">Running…</p>;
  if (state.kind === "error") return <ErrorBox message={state.message} />;

  const { result, input } = state;
  if (result.runtimeError) {
    return <ErrorBox title={result.statusMessage} message={result.runtimeError} />;
  }

  const count = result.totalTestcases ?? result.compareResult?.length ?? 0;
  const cases = Array.from({ length: count }, (_, index) => ({
    inputLines: getCaseInputLines(input, paramNames, index),
    output: result.codeAnswer?.[index] ?? "",
    expected: result.expectedCodeAnswer?.[index],
    passed: result.compareResult?.[index] === "1",
  }));

  if (cases.length === 0) return <p className="text-sm text-muted">No test cases to show.</p>;

  const allPassed = cases.every((c) => c.passed);
  const current = cases[Math.min(activeCase, cases.length - 1)];

  return (
    <div className="flex flex-col gap-3">
      <p className={`text-sm font-semibold ${allPassed ? "text-success" : "text-danger"}`}>
        {allPassed ? "Accepted" : "Wrong Answer"}
      </p>
      {result.codeOutput ? (
        <div>
          <p className="mb-1 text-xs text-muted">Stdout</p>
          <pre className="whitespace-pre-wrap rounded-md bg-panel-raised p-2 font-mono text-xs">{result.codeOutput}</pre>
        </div>
      ) : null}
      <div className="flex gap-2">
        {cases.map((c, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setActiveCase(index)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              index === activeCase ? "bg-panel-raised" : ""
            } ${c.passed ? "text-success" : "text-danger"}`}
          >
            Case {index + 1}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 text-sm">
        {current.inputLines.length > 0 ? (
          <div>
            <p className="mb-1 text-xs text-muted">Input</p>
            <div className="flex flex-col gap-2 rounded-md bg-panel-raised p-2">
              {current.inputLines.map((line, index) => (
                <div key={index}>
                  <p className="font-mono text-xs text-muted">{(paramNames[index] ?? `arg${index + 1}`)} =</p>
                  <pre className="whitespace-pre-wrap font-mono text-xs">{line}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <p className="mb-1 text-xs text-muted">Output</p>
          <pre className="whitespace-pre-wrap rounded-md bg-panel-raised p-2 font-mono text-xs">{current.output}</pre>
        </div>
        {!current.passed && current.expected !== undefined ? (
          <div>
            <p className="mb-1 text-xs text-muted">Expected</p>
            <pre className="whitespace-pre-wrap rounded-md bg-panel-raised p-2 font-mono text-xs">{current.expected}</pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OutOfContestBadge() {
  return (
    <p className="mb-2 inline-block rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">
      Out of contest — won&apos;t count toward the leaderboard
    </p>
  );
}

function SubmissionView({ state }: { state: SubmitState }) {
  if (state.kind === "idle") return <p className="text-sm text-muted">Submit your code to see the result here.</p>;
  if (state.kind === "submitting") return <p className="text-sm text-muted">Submitting…</p>;

  if (state.kind === "judging") {
    return (
      <div>
        {state.outOfContest ? <OutOfContestBadge /> : null}
        <p className="text-sm text-muted">Judging…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <p className="text-sm text-danger">
        {state.message}
        {state.retryAfterSeconds ? ` (${state.retryAfterSeconds}s)` : null}
      </p>
    );
  }

  const { verdict, outOfContest } = state;
  const isAccepted = verdict.state === "SUCCESS" && verdict.statusMessage === "Accepted";

  return (
    <div className={`text-sm ${isAccepted ? "text-success" : "text-danger"}`}>
      {outOfContest ? <OutOfContestBadge /> : null}
      <p className="font-semibold">{verdict.statusMessage}</p>
      {verdict.totalTestcases ? (
        <p className="mt-1 text-foreground">
          {verdict.totalCorrect ?? 0} / {verdict.totalTestcases} testcases passed
        </p>
      ) : null}
      {verdict.runtimeError ? <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{verdict.runtimeError}</p> : null}
      {verdict.lastTestcase ? (
        <div className="mt-2 flex flex-col gap-1 text-foreground">
          <p>Failed on: {verdict.lastTestcase}</p>
          {verdict.expectedOutput ? <p>Expected: {verdict.expectedOutput}</p> : null}
        </div>
      ) : null}
      {verdict.codeOutput ? (
        <div className="mt-2">
          <p className="mb-1 text-xs text-muted">Stdout</p>
          <pre className="whitespace-pre-wrap rounded-md bg-panel-raised p-2 font-mono text-xs text-foreground">{verdict.codeOutput}</pre>
        </div>
      ) : null}
    </div>
  );
}
