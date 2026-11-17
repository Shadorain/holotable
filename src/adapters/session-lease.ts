import { messageOf } from "../core/errors.ts";
import type { Run } from "../ports.ts";
import { withTimeout } from "../timeout.ts";

export interface SessionLeaseReport {
  sessionId: string | null;
  host: string;
  state: "held" | "not-held" | "unknown";
  checkedAt: number;
  detail: string;
}

/** Diagnostic only: an unheld lease neither proves session existence nor grants ownership. */
export async function probeSessionLease(run: Run, sessionId: string, cwd: string, host: string): Promise<SessionLeaseReport> {
  const report: SessionLeaseReport = { sessionId, host, state: "unknown", checkedAt: Date.now(), detail: "" };
  try {
    const result = await withTimeout(run("omp", ["session", "lease", "--json", "--", sessionId], cwd), 5000, "Lease probe timed out");
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Lease probe exited ${result.code}`);
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || !("held" in value) || !("unknown" in value)
      || !Array.isArray(value.held) || !Array.isArray(value.unknown)
      || value.held.length > 1 || value.unknown.length > 1
      || [...value.held, ...value.unknown].some((id) => id !== sessionId)
      || (value.held.length !== 0 && value.unknown.length !== 0))
      throw new Error("OMP returned an invalid lease report");
    report.state = value.held.length ? "held" : value.unknown.length ? "unknown" : "not-held";
    report.detail = report.state === "held" ? "A running OMP holds this session's writer lease."
      : report.state === "not-held" ? "No writer lease observed; the session may not exist. This does not authorize resuming it."
        : "OMP could not determine this session's lease state.";
  } catch (error) {
    report.detail = messageOf(error);
  }
  return report;
}
