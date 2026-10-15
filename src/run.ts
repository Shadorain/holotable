import type { Run } from "./ports.ts";

/** Longest first: worktree creation can fetch and install; everything else should answer fast. */
function timeoutFor(command: string, args: string[]): number {
  if (command === "orca" && args[0] === "worktree" && args[1] === "create") return 300_000;
  if (command === "omp" && (args[0] === "models" || args[0] === "usage")) return 10_000;
  if (command === "orca" || command === "herdr") return 130_000;
  if (command === "gh" || command === "git") return 60_000;
  return 30_000;
}

/** The one Run every adapter shares; it is the only spawn path in the service. */
export function createRun(): Run {
  return async (command, args, cwd, env) => {
    const entries = env ? Object.entries(env).map(([key, value]) => `${key}=${value}`) : [];
    const cmd = env ? ["env", ...entries, command, ...args] : [command, ...args];
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutFor(command, args) });
    } catch (error) {
      // A missing binary is a command result (127), not a thrown spawn error.
      return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 127 };
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
}
