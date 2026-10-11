import { isRecord } from "../core/validate.ts";
import { PortError } from "../ports.ts";

// Orca CLI JSON envelope helpers, copied from omp-mission/src/workers.ts:53-79
// (do not import across repos) with errors rethrown as PortError.

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function orcaError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = value.error;
  if (typeof error === "string") return error;
  if (!isRecord(error)) return undefined;
  const { code, message } = error;
  const detail = [code, message]
    .filter((part, index, all): part is string => typeof part === "string" && all.indexOf(part) === index)
    .join(": ");
  if (!detail) return undefined;
  return code === "selector_not_found"
    ? `${detail} (Orca does not know this worktree; register the checkout with Orca first)`
    : detail;
}

export function unwrap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new PortError("orca", "Orca returned invalid JSON object");
  if (value.ok === false) throw new PortError("orca", orcaError(value) ?? "Orca command failed");
  if (isRecord(value.result)) return value.result;
  return value;
}

export function decode(result: { stdout: string; stderr: string; code: number }): Record<string, unknown> {
  if (result.code !== 0) {
    let reported: string | undefined;
    try {
      reported = orcaError(JSON.parse(result.stdout));
    } catch {
      /* stdout was not JSON */
    }
    throw new PortError("orca", result.stderr || reported || `orca command failed (${result.code})`);
  }
  try {
    return unwrap(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof PortError) throw error;
    throw new PortError("orca", `invalid Orca JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
