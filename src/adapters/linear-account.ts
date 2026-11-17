import type { Run } from "../ports.ts";

export async function readLinearWorkspace(cwd: string, run: Run): Promise<string | undefined> {
  const result = await run("git", ["config", "--local", "--get", "mission.linearWorkspace"], cwd);
  if (result.code === 1) return undefined;
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read Linear workspace configuration");
  return result.stdout.trim() || undefined;
}
