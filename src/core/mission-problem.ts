import type { ContactStatus, MissionProblem } from "./types.ts";

export function missionProblem(status: ContactStatus | null): MissionProblem | null {
  if (!status || status.complete) return null;
  if (status.problem !== undefined) return status.problem;
  // Older running panes expose only the next-step text. This is presentation only:
  // no inferred error or deadline grants a control capability or schedules a retry.
  const detail = status.next ?? "";
  if (status.hold !== "quota" && !/review (?:failed|timed out|retries)|reviewer (?:error|aborted)|worker stopped|rate[_ -]?limit|quota.{0,40}exhausted/i.test(detail)) return null;
  return {
    kind: status.hold === "quota" ? "quota" : /rate[_ -]?limit|\b429\b/i.test(detail) ? "rate-limit"
      : /deadline exceeded|timed out|timeout/i.test(detail) ? "timeout" : "error",
    source: status.phase === "review" ? "review" : "worker",
    detail: detail || "Provider quota exhausted", retryAt: null, attempt: null, completed: null, total: null,
  };
}

export function retryWaiting(status: ContactStatus | null): boolean {
  return Boolean(status?.problem?.retryAt || (status?.problem === undefined && /^Review retries automatically at /i.test(status?.next ?? "")));
}
