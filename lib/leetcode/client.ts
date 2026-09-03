import "server-only";

// Minimal LeetCode GraphQL client — just enough to answer "who is this
// session logged in as" for the sync flow (Epic 01). Submission/judging
// calls (Epic 03's proxy) get their own client when that epic starts.
//
// LeetCode's GraphQL API is unofficial and undocumented, so the query shape
// and request headers here are verified against a maintained open-source
// client (JacobLinCool/LeetCode-Query, src/graphql/whoami.graphql) rather
// than guessed.

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";

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

export type LeetCodeCredentials = {
  session: string;
  csrf: string;
};

export type LeetCodeIdentity = {
  userId: string;
  username: string;
  avatar: string | null;
};

// Returns null for a session/csrf pair that isn't currently signed in on
// LeetCode (expired, revoked, or just a bad paste) — the sync route treats
// that as an ordinary validation failure, not a crash. Throws only on an
// actual transport/HTTP failure talking to LeetCode.
export async function fetchLeetCodeIdentity(
  credentials: LeetCodeCredentials,
): Promise<LeetCodeIdentity | null> {
  const response = await fetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://leetcode.com",
      referer: "https://leetcode.com",
      cookie: `LEETCODE_SESSION=${credentials.session}; csrftoken=${credentials.csrf}`,
      "x-csrftoken": credentials.csrf,
    },
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
