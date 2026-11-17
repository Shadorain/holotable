import type { TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type ListedTerminal, type Run } from "../ports.ts";
import { decode } from "./orca-envelope.ts";
import { withTimeout } from "../timeout.ts";

export async function requireOrcaChat(run: Run, cwd: string, host = "local"): Promise<void> {
  const requirements: [string[], string[]][] = [
    [["agent", "launch"], ["target-kind", "strict", "env", "config", "append-system-prompt", "prompt", "mode", "model", "effort", "session-dir"]],
    [["worktree", "create"], ["pinned", "no-terminal"]],
    [["session", "list"], []],
    [["session", "focus"], ["execution-host", "worktree", "fence"]],
    [["session", "close"], ["execution-host", "worktree", "fence"]],
  ];
  for (const [command, flags] of requirements) {
    const result = await withTimeout(run("orca", [...command, "--host", host, "--help"], cwd), 5000, `Orca Chat capability probe timed out (${command.join(" ")})`);
    if (result.code !== 0 || flags.some((flag) => !new RegExp(`^\\s+--${flag}(?=[\\s=<]|$)`, "m").test(result.stdout)))
      throw new PortError("orca-chat-unavailable", `Orca Chat needs the native mission launch and fenced session CLI APIs (${command.join(" ")}). Update the host CLI and runtime; terminal fallback is disabled.`);
  }
}

function launchArgs(input: Parameters<FrontendPort["openTerminal"]>[0]): string[] {
  if (input.argv[0]?.split("/").at(-1) !== "omp")
    throw new PortError("orca-chat-launch", "Orca Chat can launch only OMP sessions");
  const args = ["agent", "launch", "--agent", "omp", "--worktree", input.worktreeId ? `id:${input.worktreeId}` : `path:${input.worktree}`, "--target-kind", "structured-session", "--strict", "--mode", input.sessionMode ?? "default"];
  const options: Record<string, string> = {
    "--config": "--config", "--append-system-prompt": "--append-system-prompt",
    "--model": "--model", "--thinking": "--effort", "--session-dir": "--session-dir",
  };
  let prompt: string | undefined;
  let positional = false;
  for (let index = 1; index < input.argv.length; index++) {
    const arg = input.argv[index]!;
    if (arg === "--" && !positional) { positional = true; continue; }
    if (!positional && arg.startsWith("-")) {
      const option = options[arg];
      if (!Object.hasOwn(options, arg) || !option || index + 1 >= input.argv.length)
        throw new PortError("orca-chat-launch", `Unsupported OMP startup option: ${arg}`);
      args.push(option, input.argv[++index]!);
    } else {
      if (prompt !== undefined) throw new PortError("orca-chat-launch", "OMP Chat requires one initial prompt argument");
      prompt = arg;
    }
  }
  if (prompt !== undefined) args.push("--prompt", prompt);
  for (const [key, value] of Object.entries(input.env)) args.push("--env", `${key}=${value}`);
  return args;
}

/** Workspace operations come from an Orca frontend configured with noTerminal, never its PTY methods. */
export function orcaChatFrontend(base: FrontendPort, run: Run, cwd = process.cwd(), host = "local"): FrontendPort {
  function sessionRow(value: unknown): ListedTerminal | null {
    if (!isRecord(value) || typeof value.executionHostId !== "string")
      throw new PortError("orca-chat-inventory", "Orca session has no execution host identity");
    if (value.executionHostId !== host) return null;
    if (value.wslDistro !== null && value.wslDistro !== undefined)
      throw new PortError("orca-chat-inventory", "WSL session paths require a separate supported execution host");
    if (typeof value.sessionId !== "string" || !value.sessionId ||
        typeof value.agent !== "string" || !value.agent ||
        typeof value.worktreeId !== "string" || !value.worktreeId ||
        typeof value.worktreePath !== "string" || !value.worktreePath.startsWith("/") ||
        !Number.isSafeInteger(value.incarnation) || (value.incarnation as number) < 0 ||
        !["starting", "alive", "exited"].includes(value.liveness as string))
      throw new PortError("orca-chat-inventory", "Orca session has incomplete worktree, fence or liveness identity");
    return {
      handle: value.sessionId, incarnationId: String(value.incarnation), host,
      worktreeId: value.worktreeId, worktree: value.worktreePath,
      // A host-held startup reserves capacity; a durable exited row never does.
      connected: value.liveness !== "exited", session: value.agent === "omp",
    };
  }
  async function sessions(): Promise<ListedTerminal[]> {
    const payload = decode(await run("orca", ["session", "list", "--host", host, "--json"], cwd));
    if (!Array.isArray(payload.sessions)) throw new PortError("orca-chat-inventory", "Orca omitted its session inventory");
    if (Array.isArray(payload.omitted) && payload.omitted.some((entry) => !isRecord(entry) || entry.liveness !== "exited"))
      throw new PortError("orca-chat-inventory", "Orca could not resolve every active session's worktree");
    const rows: ListedTerminal[] = [];
    for (const value of payload.sessions) {
      const row = sessionRow(value);
      if (row) rows.push(row);
    }
    return rows;
  }
  async function identity(t: TerminalRef, worktree: string): Promise<ListedTerminal> {
    if (t.host !== host || !t.worktreeId)
      throw new PortError("terminal-missing", "Native session is missing its execution host or worktree identity");
    const row = (await sessions()).find((candidate) =>
      candidate.handle === t.handle && candidate.incarnationId === t.incarnationId &&
      candidate.worktreeId === t.worktreeId && candidate.worktree === worktree && candidate.connected && candidate.session);
    if (!row) throw new PortError("terminal-missing", "Native session exited or its worktree/incarnation changed");
    return row;
  }
  async function act(action: "focus" | "close", t: TerminalRef, worktree: string): Promise<void> {
    await identity(t, worktree);
    decode(await run("orca", ["session", action, t.handle, "--execution-host", host,
      "--worktree", t.worktreeId!, "--fence", t.incarnationId, "--host", host, "--json"], cwd));
  }
  async function capabilities(): Promise<void> {
    await requireOrcaChat(run, cwd, host);
    await withTimeout(sessions(), 5000, `Orca Chat inventory timed out on ${host}`);
  }
  return {
    id: "orca-chat",
    async ensureRepo(repo) { await capabilities(); await base.ensureRepo(repo); },
    async createWorkspace(input) { await capabilities(); return base.createWorkspace(input); },
    async openTerminal(input) {
      const payload = decode(await run("orca", [...launchArgs(input), "--host", host, "--json"], cwd));
      const outcome = payload.outcome;
      if (!isRecord(outcome) || outcome.kind !== "structured" || typeof outcome.sessionId !== "string" ||
          typeof payload.worktreeId !== "string" || !payload.worktreeId ||
          !isRecord(payload.receipt) || payload.receipt.mode !== "structured")
        throw new PortError("orca-chat-launch", "Orca refused a strictly structured OMP session; terminal fallback is disabled");
      if (input.worktreeId && payload.worktreeId !== input.worktreeId)
        throw new PortError("orca-chat-launch", "Orca launched the session in a different worktree");
      const row = sessionRow(payload.session);
      if (!row || row.handle !== outcome.sessionId || row.worktreeId !== payload.worktreeId ||
          row.worktree !== input.worktree || !row.connected || !row.session)
        throw new PortError("orca-chat-launch", "Orca did not return the launched session's exact live identity");
      return { handle: row.handle, incarnationId: row.incarnationId, host, worktreeId: row.worktreeId };
    },
    listTerminals: sessions,
    focus: (t, worktree) => act("focus", t, worktree),
    close: (t, worktree) => act("close", t, worktree),
    removeWorkspace: (input) => base.removeWorkspace(input),
  };
}
