// Maps LeetCode's own status_msg strings to public.submissions' verdict
// check constraint (pending/accepted/wrong_answer/runtime_error/
// time_limit_exceeded/compile_error/other).
export function toVerdict(statusMessage: string): string {
  switch (statusMessage) {
    case "Accepted":
      return "accepted";
    case "Wrong Answer":
      return "wrong_answer";
    case "Runtime Error":
      return "runtime_error";
    case "Time Limit Exceeded":
      return "time_limit_exceeded";
    case "Compile Error":
      return "compile_error";
    default:
      return "other";
  }
}
