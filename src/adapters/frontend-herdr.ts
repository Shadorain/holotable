import type { TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type Run } from "../ports.ts";
import { gitWorkspaces } from "./git-workspaces.ts";

function fail(result: { code: number; stderr: string; stdout: string }, label: string): void {
  if (result.code === 0) return;
  throw new PortError("herdr", result.stderr.trim() || result.stdout.trim() || `${label} failed (${result.code})`);
}

// From omp-mission/src/hosts.ts:34-43 — herdr tab create prints JSON with the
// new tab id and root pane id under result or at top level.
function parseHerdrIds(stdout: string): { tabId: string; paneId: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new PortError("herdr", "herdr tab create returned invalid JSON");
  }
  const top = isRecord(payload) ? payload : undefined;
  const result = isRecord(top?.result) ? top.result : top;
  const tabId =
    isRecord(result?.tab) && typeof result.tab.tab_id === "string" ? result.tab.tab_id
    : isRecord(result?.tab) && typeof result.tab.id === "string" ? result.tab.id
    : typeof result?.tab_id === "string" ? result.tab_id
    : undefined;
  const paneId =
    isRecord(result?.root_pane) && typeof result.root_pane.pane_id === "string" ? result.root_pane.pane_id
    : isRecord(result?.root_pane) && typeof result.root_pane.id === "string" ? result.root_pane.id
    : typeof result?.pane_id === "string" ? result.pane_id
    : undefined;
  if (!tabId || !paneId) throw new PortError("herdr", "herdr tab create omitted tab or root pane id");
  return { tabId, paneId };
}

// herdr CLI replies are a JSON envelope; a failed call puts error.code on
// stdout (e.g. {"id":"cli:tab:get","error":{"code":"not_found",…}}).
function herdrErrorCode(stdout: string): string | null {
  try {
    const payload: unknown = JSON.parse(stdout);
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string")
      return payload.error.code;
  } catch {}
  return null;
}

// herdr tab close fails on an already-gone tab with a generic error; callers
// need "terminal-missing" (same as orca's validatedTerminal) to free the slot.
async function assertTabExists(run: Run, t: TerminalRef): Promise<void> {
  const got = await run("herdr", ["tab", "get", t.incarnationId], process.cwd());
  if (got.code === 0) return;
  const code = herdrErrorCode(got.stdout) ?? herdrErrorCode(got.stderr);
  if (code !== null && code.endsWith("not_found"))
    throw new PortError("terminal-missing", `Terminal ${t.handle} is gone`);
  fail(got, "herdr tab get");
}

export function herdrFrontend(run: Run, worktreeRoot?: string): FrontendPort {
  const workspaces = gitWorkspaces(run, worktreeRoot);
  return {
    id: "herdr",
    ensureRepo: workspaces.ensureRepo,
    createWorkspace: workspaces.createWorkspace,
    removeWorkspace: workspaces.removeWorkspace,

    async openTerminal(i) {
      if (i.argv[0] !== "omp")
        throw new PortError("herdr-needs-omp", "herdr agent start only supports omp launches");
      const env = Object.entries(i.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      const created = await run(
        "herdr",
        ["tab", "create", "--cwd", i.worktree, "--label", i.title, "--no-focus", ...env],
        i.worktree,
      );
      fail(created, "herdr tab create");
      const ids = parseHerdrIds(created.stdout);
      const started = await run(
        "herdr",
        ["agent", "start", i.title, "--kind", "omp", "--pane", ids.paneId, "--timeout", "30000", "--", ...i.argv.slice(1)],
        i.worktree,
      );
      if (started.code !== 0) {
        await run("herdr", ["tab", "close", ids.tabId], i.worktree);
        fail(started, "herdr agent start");
      }
      return { handle: i.title, incarnationId: ids.tabId };
    },

    // herdr agent list has no JSON form on this host (0.9.0): cannot enumerate.
    async listTerminals() {
      return null;
    },

    async focus(t: TerminalRef) {
      fail(await run("herdr", ["tab", "focus", t.incarnationId], process.cwd()), "herdr tab focus");
    },

    async close(t: TerminalRef) {
      await assertTabExists(run, t);
      fail(await run("herdr", ["tab", "close", t.incarnationId], process.cwd()), "herdr tab close");
    },
  };
}
