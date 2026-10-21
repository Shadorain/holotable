import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { procAlive } from "../machine.ts";
import type { ContactStatus } from "../core/types.ts";
import { validateStatus } from "../core/validate-status.ts";
import { PortError, type FleetPort } from "../ports.ts";

const PING_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 150_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_CONFLICT_PATHS = 20;

const markerCache = new Set<string>();
// The extension's control-socket eligibility is OMP_HOLOTABLE_CHILD or a <id>.ctl marker in
// the status dir. Missions launched before the marker existed have neither when a pane is
// revived without the launch env (e.g. an IDE resurrecting the pane), so the owner serves
// nothing and every relaunch spawns a read-only orphan. A tracked status file is proof the
// board owns this mission: backfill the marker once so the owner starts serving.
async function backfillCtlMarker(statusPath: string): Promise<void> {
  const marker = join(dirname(statusPath), `${basename(statusPath, ".json")}.ctl`);
  if (markerCache.has(marker)) return;
  markerCache.add(marker);
  await writeFile(marker, `${process.pid}\n`, { mode: 0o600, flag: "wx" }).catch(() => undefined);
}

const STATUS_CACHE_LIMIT = 500;
// fleet.read runs once per contact per watcher pass; re-parse a status file
// (and re-resolve its worktree) only when it changed. Bounded to stay small.
const statusCache = new Map<string, { mtimeMs: number; status: ContactStatus; worktree: string }>();

export interface MissionFleetOptions {
  agentDir: string;
  /** Called once per status file that fails validation. */
  onInvalidStatus?: (path: string, error: Error) => void;
}

interface SocketResponse {
  ok: boolean;
  revision?: string;
  plan?: { text: string; path: string; revision: string };
  error?: { code: string; message: string };
}

// Newline-delimited JSON: one request, one response line, then close. Write the
// request but never half-close: Bun drops a reply that arrives after end().
function socketRequest(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<SocketResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<SocketResponse>();
  const socket = connect(path);
  let done = false;
  const finish = (error?: Error, value?: SocketResponse) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.destroy();
    if (error) reject(error);
    else resolve(value as SocketResponse);
  };
  const timer = setTimeout(
    () => finish(new PortError("owner-offline", `Timed out connecting to ${path}`)),
    timeoutMs,
  );
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let bytes = 0;
  socket.on("error", (error: NodeJS.ErrnoException) =>
    finish(new PortError("owner-offline", `${error.code ?? "socket error"}: ${error.message}`)),
  );
  socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    bytes += chunk.length;
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      if (bytes > MAX_LINE_BYTES)
        finish(new PortError("bad-response", `Response from ${path} exceeds ${MAX_LINE_BYTES} bytes`));
      return;
    }
    const line = buffer.slice(0, newline);
    try {
      finish(undefined, JSON.parse(line) as SocketResponse);
    } catch (error) {
      finish(new PortError("bad-response", `Unparseable response from ${path}: ${String(error)}`));
    }
  });
  socket.on("close", () => {
    if (!done) finish(new PortError("owner-offline", `Socket ${path} closed without a reply`));
  });
  return promise;
}

export function ompMissionFleet(options: MissionFleetOptions): FleetPort {
  const { agentDir, onInvalidStatus } = options;

  async function read(i: { worktree: string }): Promise<ContactStatus | null> {
    let wanted: string;
    try {
      wanted = await realpath(i.worktree);
    } catch {
      return null;
    }
    const root = join(agentDir, "missions");
    let workspaces: string[];
    try {
      workspaces = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let newest: { status: ContactStatus; updatedAt: number } | null = null;
    for (const workspace of workspaces) {
      const directory = join(root, workspace, "status");
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        const path = join(directory, name);
        let meta;
        try {
          meta = await stat(path);
        } catch {
          continue;
        }
        const cached = statusCache.get(path);
        let status: ContactStatus;
        let worktree: string;
        if (cached && cached.mtimeMs === meta.mtimeMs) {
          status = cached.status;
          worktree = cached.worktree;
        } else {
          try {
            status = validateStatus(JSON.parse(await readFile(path, "utf8")), path);
          } catch (error) {
            onInvalidStatus?.(path, error as Error);
            continue;
          }
          try {
            worktree = await realpath(status.worktree);
          } catch {
            continue;
          }
          if (statusCache.size >= STATUS_CACHE_LIMIT)
            statusCache.delete(statusCache.keys().next().value as string);
          statusCache.set(path, { mtimeMs: meta.mtimeMs, status, worktree });
          void backfillCtlMarker(path);
        }
        if (worktree !== wanted) continue;
        const updatedAt = Date.parse(status.updatedAt);
        if (Number.isNaN(updatedAt)) continue;
        if (!newest || updatedAt > newest.updatedAt) newest = { status, updatedAt };
      }
    }
    return newest?.status ?? null;
  }

  async function ping(status: ContactStatus): Promise<boolean> {
    if (!status.ctl) return false;
    try {
      const reply = await socketRequest(status.ctl.socket, { v: 1, op: "ping" }, PING_TIMEOUT_MS);
      return reply.ok === true;
    } catch {
      return false;
    }
  }

  async function running(status: ContactStatus): Promise<boolean | null> {
    const session = status.session;
    if (!session) return null;
    return procAlive(session.pid, session.processStart);
  }

  async function control(
    status: ContactStatus,
    op: Parameters<FleetPort["control"]>[1],
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!status.ctl)
      throw new PortError("no-session", "Mission has no control socket (not launched by holotable)");
    const payload: Record<string, unknown> = { v: 1, op, args, operator: true };
    if (op === "approve") (payload.args as Record<string, unknown>).gate = status.gate?.id ?? null;
    const reply = await socketRequest(status.ctl.socket, payload, CONTROL_TIMEOUT_MS);
    if (reply.ok === true) return;
    const code = reply.error?.code ?? "bad-response";
    const message = reply.error?.message ?? `Mission returned a malformed error for ${op}`;
    throw new PortError(code, message);
  }

  /** The read side of plan review: no operator flag, `no-plan` maps to null. */
  async function readPlan(status: ContactStatus): Promise<{ text: string; path: string; revision: string } | null> {
    if (!status.ctl)
      throw new PortError("no-session", "Mission has no control socket (not launched by holotable)");
    const reply = await socketRequest(status.ctl.socket, { v: 1, op: "plan", args: {} }, CONTROL_TIMEOUT_MS);
    if (reply.ok === true) {
      const plan = reply.plan;
      if (
        typeof plan !== "object" || plan === null ||
        typeof (plan as Record<string, unknown>).text !== "string" ||
        typeof (plan as Record<string, unknown>).path !== "string" ||
        typeof (plan as Record<string, unknown>).revision !== "string"
      )
        throw new PortError("bad-response", "Mission returned a malformed plan");
      return plan as { text: string; path: string; revision: string };
    }
    if (reply.error?.code === "no-plan") return null;
    throw new PortError(reply.error?.code ?? "bad-response", reply.error?.message ?? "Mission returned a malformed error for plan");
  }

  return {
    id: "omp-mission",
    launch(i) {
      const { operation, contact } = i;
      // Flags go before `--`: omp-mission treats everything after it as the freeform description.
      const pause = operation.pause ? " --pause" : "";
      let message: string;
      if (contact.kind === "conflict") {
        const paths = i.conflictPaths ?? [];
        const more = paths.length > MAX_CONFLICT_PATHS ? ` and ${paths.length - MAX_CONFLICT_PATHS} more` : "";
        // The worktree holds an unfinished merge: committing it is what makes this branch the resolution Land pushes.
        message = `/mission${pause} -- Resolve the merge conflicts in ${paths.slice(0, MAX_CONFLICT_PATHS).join(", ")}${more} of ${contact.conflictOf}. Edit only those files, then git add them and conclude the merge with git commit --no-edit. Do not push or open a PR; Holotable lands this branch.`;
      } else if (operation.tracker === "none") {
        const text = (contact.description && contact.description.trim().length > 0)
          ? contact.description
          : (contact.title ?? contact.ticket);
        message = `/mission${pause} -- ${text.replace(/\s+/g, " ").trim()}`;
      } else {
        message = `/mission ${contact.ticket}${pause}`;
      }
      const argv = ["omp", "--config", i.overlay];
      // Mission extras parse option-looking words as flags, even inside task prose.
      if (operation.tracker !== "none" && contact.kind !== "conflict" && contact.description?.trim())
        argv.push("--append-system-prompt", `Additional scope for mission ${contact.ticket}:\n\n${contact.description}`);
      if (i.model) argv.push("--model", i.model);
      if (i.thinking) argv.push("--thinking", i.thinking);
      return {
        argv,
        env: {
          OMP_MISSION_AUTOSTART: message,
          OMP_HOLOTABLE_CHILD: "1",
          OMP_MISSION_CHECKOUT: i.worktree,
          OMP_MISSION_BASE: operation.base,
          OMP_MISSION_GRAPH: contact.kind === "conflict" ? "local" : "beads",
          OMP_MISSION_DELIVERY: contact.kind === "implement" && operation.delivery === "github-pr" ? "pr" : "local",
        },
      };
    },
    running,
    read,
    ping,
    control,
    readPlan,
  };
}
