import "server-only";

// LeetCode GraphQL/REST client. LeetCode's API is unofficial and
// undocumented — the identity query (whoami) was verified against a
// maintained open-source client (JacobLinCool/LeetCode-Query). The
// problem/submit/check-status calls below are ported from this project's
// own v1 prototype instead, which is the one piece v1 actually proved
// worked end-to-end against the real site (see docs/README.md) — that's
// a stronger signal than any third-party reference for exactly these
// mutating, more-protected endpoints.

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";

export type LeetCodeCredentials = {
  session: string;
  csrf: string;
};

function leetCodeHeaders(credentials: LeetCodeCredentials, referer: string) {
  return {
    "content-type": "application/json",
    origin: "https://leetcode.com",
    referer,
    cookie: `LEETCODE_SESSION=${credentials.session}; csrftoken=${credentials.csrf}`,
    "x-csrftoken": credentials.csrf,
  };
}

const WHOAMI_QUERY = `
  query whoami {
    userStatus {
      userId
      username
      avatar
      isSignedIn
    }
  }
`;

export type LeetCodeIdentity = {
  userId: string;
  username: string;
  avatar: string | null;
};

// Returns null for a session/csrf pair that isn't currently signed in on
// LeetCode (expired, revoked, or just a bad paste) — callers treat that as
// an ordinary validation failure, not a crash. Throws only on an actual
// transport/HTTP failure talking to LeetCode.
export async function fetchLeetCodeIdentity(
  credentials: LeetCodeCredentials,
): Promise<LeetCodeIdentity | null> {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: leetCodeHeaders(credentials, "https://leetcode.com"),
    body: JSON.stringify({
      query: WHOAMI_QUERY,
      variables: {},
      operationName: "whoami",
    }),
  });

  if (!response.ok) {
    throw new Error(`LeetCode GraphQL request failed: ${response.status}`);
  }

  const json = await response.json();
  const status = json?.data?.userStatus;

  if (!status?.isSignedIn || !status.userId) {
    return null;
  }

  return {
    userId: String(status.userId),
    username: status.username,
    avatar: status.avatar ?? null,
  };
}

const GET_PROBLEM_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      title
      titleSlug
      content
      difficulty
      exampleTestcases
      codeSnippets {
        lang
        langSlug
        code
      }
    }
  }
`;

export type LeetCodeProblem = {
  questionId: string;
  title: string;
  titleSlug: string;
  content: string;
  difficulty: "Easy" | "Medium" | "Hard";
  exampleTestcases: string;
  codeSnippets: { lang: string; langSlug: string; code: string }[];
};

export async function fetchProblem(
  slug: string,
  credentials: LeetCodeCredentials,
): Promise<LeetCodeProblem | null> {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: leetCodeHeaders(credentials, `https://leetcode.com/problems/${slug}/`),
    body: JSON.stringify({
      query: GET_PROBLEM_QUERY,
      variables: { titleSlug: slug },
      operationName: "questionData",
    }),
  });

  if (!response.ok) {
    throw new Error(`LeetCode GraphQL request failed: ${response.status}`);
  }

  const json = await response.json();
  const question = json?.data?.question;

  return question ?? null;
}

export type LeetCodeSubmitResult = {
  submissionId: string;
};

// questionId comes from a prior fetchProblem call — the caller passes it
// through rather than this function re-fetching it, since the client
// already has it from loading the problem.
export async function submitSolution(
  slug: string,
  langSlug: string,
  code: string,
  questionId: string,
  credentials: LeetCodeCredentials,
): Promise<LeetCodeSubmitResult> {
  const response = await fetch(`https://leetcode.com/problems/${slug}/submit/`, {
    method: "POST",
    headers: leetCodeHeaders(credentials, `https://leetcode.com/problems/${slug}/`),
    body: JSON.stringify({
      lang: langSlug,
      question_id: questionId,
      typed_code: code,
    }),
  });

  if (response.status === 429) {
    throw new LeetCodeRateLimitError();
  }

  if (!response.ok) {
    throw new Error(`LeetCode submit failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.submission_id) {
    // LeetCode returns 200 with an HTML login page (not JSON with a
    // submission_id) when the session has actually expired mid-request —
    // treat a missing id as the same "not signed in" signal as whoami.
    throw new LeetCodeSessionExpiredError();
  }

  return { submissionId: String(data.submission_id) };
}

export class LeetCodeRateLimitError extends Error {
  constructor() {
    super("LeetCode rate-limited this submission.");
  }
}

export class LeetCodeSessionExpiredError extends Error {
  constructor() {
    super("LeetCode session expired mid-request.");
  }
}

export type LeetCodeSubmissionStatus = {
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  statusMessage: string;
  runSuccess?: boolean;
  totalCorrect?: number;
  totalTestcases?: number;
  runtimeError?: string;
  // Only present on a Wrong Answer verdict — the specific case LeetCode's
  // judge stopped on, not the full set (LeetCode itself only ever returns
  // the first failing case, not every one).
  lastTestcase?: string;
  expectedOutput?: string;
  codeOutput?: string;
};

export async function checkSubmissionStatus(
  submissionId: string,
  credentials: LeetCodeCredentials,
): Promise<LeetCodeSubmissionStatus> {
  const response = await fetch(
    `https://leetcode.com/submissions/detail/${submissionId}/check/`,
    {
      method: "GET",
      headers: leetCodeHeaders(
        credentials,
        `https://leetcode.com/submissions/detail/${submissionId}/`,
      ),
    },
  );

  if (!response.ok) {
    throw new Error(`LeetCode submission-status check failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    state: data.state,
    statusMessage: data.status_msg,
    runSuccess: data.run_success,
    totalCorrect: data.total_correct,
    totalTestcases: data.total_testcases,
    runtimeError: data.runtime_error ?? data.full_runtime_error,
    lastTestcase: data.last_testcase,
    expectedOutput: data.expected_output,
    codeOutput: Array.isArray(data.code_output) ? data.code_output.join("\n") : data.code_output,
  };
}

export type LeetCodeInterpretResult = {
  interpretId: string;
};

// LeetCode's "Run" — tests against example/custom cases via a separate
// endpoint from submit/, so it never counts as a real judged attempt. Same
// questionId-from-caller convention as submitSolution.
export async function interpretSolution(
  slug: string,
  langSlug: string,
  code: string,
  questionId: string,
  dataInput: string,
  credentials: LeetCodeCredentials,
): Promise<LeetCodeInterpretResult> {
  const response = await fetch(`https://leetcode.com/problems/${slug}/interpret_solution/`, {
    method: "POST",
    headers: leetCodeHeaders(credentials, `https://leetcode.com/problems/${slug}/`),
    body: JSON.stringify({
      lang: langSlug,
      question_id: questionId,
      typed_code: code,
      data_input: dataInput,
    }),
  });

  if (response.status === 429) {
    throw new LeetCodeRateLimitError();
  }

  if (!response.ok) {
    throw new Error(`LeetCode run failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.interpret_id) {
    throw new LeetCodeSessionExpiredError();
  }

  return { interpretId: String(data.interpret_id) };
}

export type LeetCodeInterpretStatus = {
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  statusMessage: string;
  totalCorrect?: number;
  totalTestcases?: number;
  runtimeError?: string;
  // Per-case results. codeAnswer/expectedCodeAnswer are parallel arrays but
  // LeetCode pads them with one extra trailing entry beyond totalTestcases
  // — only the first totalTestcases entries are real. compareResult is the
  // authoritative pass/fail signal: a "1"/"0" string, one char per real
  // case (string-comparing codeAnswer vs expectedCodeAnswer is NOT
  // reliable — LeetCode itself is the only source of truth here).
  codeAnswer?: string[];
  expectedCodeAnswer?: string[];
  compareResult?: string;
};

// Same check/ endpoint as a real submission — LeetCode uses one generic
// "is this async job done yet" check for both submission ids and interpret
// ids, just with a different response shape.
export async function checkInterpretStatus(
  interpretId: string,
  credentials: LeetCodeCredentials,
): Promise<LeetCodeInterpretStatus> {
  const response = await fetch(
    `https://leetcode.com/submissions/detail/${interpretId}/check/`,
    {
      method: "GET",
      headers: leetCodeHeaders(
        credentials,
        `https://leetcode.com/submissions/detail/${interpretId}/`,
      ),
    },
  );

  if (!response.ok) {
    throw new Error(`LeetCode run-status check failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    state: data.state,
    statusMessage: data.status_msg,
    totalCorrect: data.total_correct,
    totalTestcases: data.total_testcases,
    runtimeError: data.runtime_error ?? data.full_runtime_error,
    codeAnswer: data.code_answer,
    expectedCodeAnswer: data.expected_code_answer,
    compareResult: data.compare_result,
  };
}
