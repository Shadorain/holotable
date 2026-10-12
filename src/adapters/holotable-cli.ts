import { fileURLToPath } from "node:url";
import type { CommandOutcome } from "../commands.ts";
import type { ServiceHealth } from "../plugin/client.ts";
import type { Run } from "../ports.ts";
import { createRun } from "../run.ts";

export interface CliReply extends CommandOutcome {
  service?: ServiceHealth;
}

export interface CliContext {
  home: string;
  cwd: string;
  current: string | null;
  run?: Run;
}

/** Use the plugin's own CLI version; shell PATH installation is optional for OMP. */
export async function runHolotable(args: string[], context: CliContext): Promise<CliReply> {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Holotable needs Bun on PATH. Install it from https://bun.sh.");
  const script = fileURLToPath(new URL("../../bin/holotable.ts", import.meta.url));
  const result = await (context.run ?? createRun())(bun, [
    script, "--json", "--home", context.home, "--current", context.current ?? "", ...args,
  ], context.cwd);
  let reply: CliReply & { error?: string };
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr.trim() || `Holotable CLI returned an invalid response (exit ${result.code}).`);
  }
  if (result.code !== 0 && !(result.code === 3 && reply.service?.running === false))
    throw new Error(reply.error ?? (result.stderr.trim() || `Holotable CLI exited ${result.code}.`));
  if (typeof reply.message !== "string") throw new Error("Holotable CLI returned an invalid response.");
  return reply;
}
