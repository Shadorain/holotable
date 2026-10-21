import { homedir } from "node:os";
import type { Operation, Settings } from "../core/types.ts";
import { messageOf } from "../core/errors.ts";
import { isRecord } from "../core/validate.ts";
import { expandWorktreeRoot } from "../core/worktrees.ts";
import type { Run } from "../ports.ts";
import { decode } from "./orca-envelope.ts";

export interface WorkspaceInfo {
  /** Folder lanes go in; for git-managed lanes `{name}` is left in place. */
  path: string | null;
  source: "orca-project" | "operation" | "settings" | "none";
  note: string | null;
}

/** Where this operation's next lane will be created, and which setting decides it. */
export async function workspaceInfo(op: Operation, settings: Settings, run: Run | undefined): Promise<WorkspaceInfo> {
  if (op.frontend === "none")
    return { path: null, source: "none", note: "No frontend: contacts can only adopt an existing worktree (add --worktree)." };
  if (op.frontend === "orca") {
    if (!run) return { path: null, source: "none", note: "Orca decides; the board cannot ask it from here." };
    try {
      const result = decode(await run("orca", ["repo", "show", "--repo", `path:${op.repo}`, "--json"], op.repo));
      const repo = isRecord(result.repo) ? result.repo : result;
      const base = repo.worktreeBasePath;
      if (typeof base === "string" && base.length)
        return { path: base, source: "orca-project", note: "Set in Orca's project settings." };
      return { path: null, source: "none", note: "Orca has no worktree folder for this project. Launch will fail until one is set in Orca's project settings." };
    } catch (error) {
      return { path: null, source: "none", note: `Cannot read Orca's project settings: ${messageOf(error)}` };
    }
  }
  const template = op.worktreeRoot ?? settings.worktrees.root;
  return {
    path: expandWorktreeRoot(template, op.repo, "{name}", homedir()),
    source: op.worktreeRoot ? "operation" : "settings",
    note: null,
  };
}
