import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_WORKTREE_ROOT, expandWorktreeRoot } from "../core/worktrees.ts";
import type { Delivery } from "../core/types.ts";
import { PortError, type Run } from "../ports.ts";

// The only place holotable runs `git worktree add`; frontends that do not
// manage worktrees themselves (herdr, custom) share this.

export interface GitWorkspacePorts {
  ensureRepo(repo: string): Promise<void>;
  createWorkspace(i: {
    repo: string;
    name: string;
    base: string;
    ticket: string | null;
    /** local-merge lands without pushing: prefer the local base ref over origin. */
    delivery?: Delivery;
  }): Promise<{ worktree: string; branch: string | null }>;
  removeWorkspace(i: { repo: string; worktree: string }): Promise<void>;
}

/** `root` is a folder template (core/worktrees.ts); its parent folders are created by git. */
export function gitWorkspaces(run: Run, root: string = DEFAULT_WORKTREE_ROOT): GitWorkspacePorts {
  function fail(result: { code: number; stderr: string; stdout: string }, label: string): void {
    if (result.code === 0) return;
    throw new PortError("git", result.stderr.trim() || result.stdout.trim() || `${label} failed (${result.code})`);
  }

  return {
    async ensureRepo() {},

    async createWorkspace(i) {
      const branch = `holotable/${i.name}`;
      const path = expandWorktreeRoot(root, i.repo, i.name, homedir());
      if (existsSync(path))
        throw new PortError("workspace-exists", `Worktree path already exists: ${path}`);
      const taken = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], i.repo);
      if (taken.code === 0) throw new PortError("workspace-exists", `Branch already exists: ${branch}`);
      const candidates =
        i.delivery === "local-merge" ? [i.base, `origin/${i.base}`] : [`origin/${i.base}`, i.base];
      let baseRef: string | undefined;
      for (const candidate of candidates) {
        const probe = await run("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], i.repo);
        if (probe.code === 0) {
          baseRef = candidate;
          break;
        }
      }
      if (!baseRef)
        throw new PortError("git", `Base branch ${i.base} not found locally or on origin`);
      const added = await run("git", ["worktree", "add", "-b", branch, path, baseRef], i.repo);
      fail(added, "git worktree add");
      return { worktree: await realpath(path), branch };
    },

    async removeWorkspace(i) {
      fail(await run("git", ["worktree", "remove", "--force", i.worktree], i.repo), "git worktree remove");
    },
  };
}
