import { createHash } from "node:crypto";
import { isRecord } from "../core/validate.ts";
import { PortError, type CommandResult, type Run } from "../ports.ts";
import { decode } from "./orca-envelope.ts";

// Authenticated non-PTY execution on an Orca execution host (`orca worktree exec`): the board's
// only remote transport. Every call carries an explicit executionHostId and an anchored registered
// worktree on that host; remote paths never resolve against the board host.

/** `local`, `ssh:<target-id>` or `runtime:<environment-id>` — Orca's executionHostId spellings. */
export type ExecutionHost = string;

const EXEC_TIMEOUT_DEFAULT_MS = 10_000;
const EXEC_TIMEOUT_MAX_MS = 180_000;
const EXEC_OUTPUT_DEFAULT_BYTES = 1024 * 1024;
const EXEC_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

export interface OrcaExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * `orca worktree exec --host <id> --worktree path:<exact> --json [--timeout-ms N]
 * [--max-output-bytes N] [--env KEY=VALUE ...] -- <argv>`. Defaults are 10s and 1MiB;
 * hard maxima are 180s and 4MiB. A nonzero child exit is a result. Timeout, output overflow,
 * and transport failures throw — never a partial parse.
 */
export async function orcaExec(
  run: Run,
  cwd: string,
  i: { host: ExecutionHost; worktree: string; argv: string[]; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number },
): Promise<OrcaExecResult> {
  const timeoutMs = i.timeoutMs ?? EXEC_TIMEOUT_DEFAULT_MS;
  const maxOutputBytes = i.maxOutputBytes ?? EXEC_OUTPUT_DEFAULT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EXEC_TIMEOUT_MAX_MS)
    throw new PortError("orca", `worktree exec timeout must be an integer from 1 to ${EXEC_TIMEOUT_MAX_MS}ms`);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > EXEC_OUTPUT_MAX_BYTES)
    throw new PortError("orca", `worktree exec output limit must be an integer from 1 to ${EXEC_OUTPUT_MAX_BYTES} bytes`);
  const args = ["worktree", "exec", "--host", i.host, "--worktree", `path:${i.worktree}`, "--json", "--timeout-ms", String(timeoutMs), "--max-output-bytes", String(maxOutputBytes)];
  if (i.env) for (const [key, value] of Object.entries(i.env)) args.push("--env", `${key}=${value}`);
  args.push("--", ...i.argv);
  const payload = decode(await run("orca", args, cwd));
  const argv = payload.argv;
  const argvOk = Array.isArray(argv) && argv.length === i.argv.length && argv.every((part, n) => part === i.argv[n]);
  if (
    !argvOk ||
    payload.hostId !== i.host ||
    payload.worktree !== i.worktree ||
    typeof payload.stdout !== "string" ||
    typeof payload.stderr !== "string" ||
    typeof payload.exitCode !== "number"
  )
    // A result stamped for another host, checkout, or argv is never an answer for this call.
    // worktree.exec only succeeds for an exact registered worktree, so a matching echo is the
    // proof the anchor is that checkout — not an ambient cwd. Overflow and transport failures
    // never reach here: the CLI fails the RPC and decode throws.
    throw new PortError("orca", "Orca worktree exec returned a malformed or foreign-host result");
  return { stdout: payload.stdout, stderr: payload.stderr, exitCode: payload.exitCode };
}

/** Orca's project-host-setup row (`projectHostSetup.list` / `orca project setups --json`). */
export interface HostSetup {
  id: string;
  projectId: string;
  /** The repo record this setup backs on its host; `id:<repoId>` is a valid repo selector there. */
  repoId: string | null;
  hostId: string;
  path: string | null;
  state: string | null;
}

export function parseHostSetups(payload: Record<string, unknown>, host: ExecutionHost): HostSetup[] {
  const rows = Array.isArray(payload.setups) ? payload.setups : [];
  const setups: HostSetup[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const hostId =
      typeof row.executionHostId === "string" ? row.executionHostId : typeof row.hostId === "string" ? row.hostId : null;
    if (hostId !== host) continue;
    setups.push({
      id: row.id,
      projectId:
        typeof row.projectId === "string" ? row.projectId : typeof row.project === "string" ? row.project : "",
      repoId: typeof row.repoId === "string" && row.repoId.length > 0 ? row.repoId : null,
      hostId,
      path: typeof row.path === "string" ? row.path : null,
      // Upstream names it setupState; `state` accepted for older producers.
      state:
        typeof row.setupState === "string" ? row.setupState : typeof row.state === "string" ? row.state : null,
    });
  }
  return setups;
}

// ---- relay ----

const RELAY_SOURCE_URL = new URL("./remote-relay.mjs", import.meta.url);
const relaySha = createHash("sha256").update(await Bun.file(RELAY_SOURCE_URL).bytes()).digest("hex").slice(0, 16);
const RELAY_NAME = `holotable-relay-${relaySha}.mjs`;
const RELAY_HOME = ".holotable";

// Deploy script, run as `bun -e` on the mission host. Atomic write (tmp + rename), 0700 dir+file,
// no trust in a cached artifact whose bytes do not hash to this build's relay source.
const DEPLOY_JS = `
const fs=require("node:fs"),crypto=require("node:crypto"),os=require("node:os"),path=require("node:path");
const dir=path.join(os.homedir(),${JSON.stringify(RELAY_HOME)}),file=path.join(dir,${JSON.stringify(RELAY_NAME)});
const b64=process.env.HOLOTABLE_RELAY_B64,want=crypto.createHash("sha256").update(Buffer.from(b64,"base64")).digest("hex");
if(fs.existsSync(dir)){
  const st=fs.lstatSync(dir);
  if(st.isSymbolicLink()||!st.isDirectory())throw new Error(dir+" is not a real directory");
}
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const cur=fs.existsSync(file)?crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"):null;
if(cur!==want){
  const tmp=file+".tmp-"+process.pid;
  fs.writeFileSync(tmp,Buffer.from(b64,"base64"),{mode:0o700});
  fs.renameSync(tmp,file);
}
process.stdout.write(file+"\\n");`;

export interface RelayOps {
  /** Verify a deployed relay answers; throws PortError otherwise. */
  ready(): Promise<void>;
  request(op: string, r: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Remote `Run`: argv executes inside the mission host, anchored at `worktree` for routing only. */
  run(command: string, args: string[], cwd: string, env?: Record<string, string>, timeoutMs?: number): Promise<CommandResult>;
  realpath(path: string): Promise<string | null>;
}

interface RelayResult {
  error?: { code: string; message: string };
  [key: string]: unknown;
}

/**
 * A deployed relay on one (host, worktree anchor). Bootstrap order matters: bun is probed and the
 * relay verified before the caller mutates any remote state, so a host without Bun fails at
 * ensureRepo with an actionable error instead of mid-launch.
 */
export function remoteRelay(run: Run, cwd: string, i: { host: ExecutionHost; worktree: string }): RelayOps {
  let interpreter: Promise<void> | null = null;
  let deployed: Promise<string> | null = null;

  async function exec(argv: string[], env?: Record<string, string>, timeoutMs?: number): Promise<OrcaExecResult> {
    return orcaExec(run, cwd, { host: i.host, worktree: i.worktree, argv, env, timeoutMs });
  }

  function ensureInterpreter(): Promise<void> {
    interpreter ??= (async () => {
      const probe = await exec(["sh", "-c", "command -v bun >/dev/null 2>&1 && bun --version"]);
      if (probe.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(probe.stdout.trim()))
        throw new PortError(
          "host-unprepared",
          `Mission host ${i.host} has no bun on PATH (probe: ${probe.stdout.trim()} ${probe.stderr.trim()}). Install Bun ≥1.0 for the placement user; Holotable relays mission status and control through it.`,
        );
    })();
    return interpreter;
  }

  // Returns the absolute relay path the remote deploy printed; content-hash + atomic rename make
  // redeploys idempotent, and a cached artifact is only trusted after its bytes hash to this build.
  function ensureDeployed(): Promise<string> {
    deployed ??= (async () => {
      await ensureInterpreter();
      const source = Buffer.from(await Bun.file(RELAY_SOURCE_URL).bytes());
      const result = await exec(["bun", "-e", DEPLOY_JS], { HOLOTABLE_RELAY_B64: source.toString("base64") });
      const path = result.stdout.trim();
      if (result.exitCode !== 0 || !path.startsWith("/") || !path.endsWith(RELAY_NAME))
        throw new PortError(
          "host-unprepared",
          `Cannot deploy the mission relay on ${i.host}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
        );
      return path;
    })();
    return deployed;
  }

  async function request(op: string, r: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const path = await ensureDeployed();
    const result = await exec(["bun", path, op], { HOLOTABLE_REQ: JSON.stringify(r) }, timeoutMs);
    if (result.exitCode !== 0)
      throw new PortError("relay", `Relay ${op} failed on ${i.host}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    let reply: RelayResult;
    try {
      reply = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as RelayResult;
    } catch {
      throw new PortError("bad-response", `Relay ${op} returned invalid JSON on ${i.host}`);
    }
    if (isRecord(reply.error) && typeof reply.error.code === "string")
      throw new PortError(reply.error.code, typeof reply.error.message === "string" ? reply.error.message : `relay ${op} failed`);
    return reply;
  }

  let verified = false;

  return {
    async ready() {
      if (verified) return;
      const pong = await request("ping", {}, 10_000);
      if (pong.ok !== true) throw new PortError("host-unprepared", `Mission relay on ${i.host} did not answer ping`);
      verified = true;
    },
    request,
    async run(command, args, runCwd, env, timeoutMs = 60_000) {
      await this.ready();
      const reply = await request(
        "run",
        { argv: [command, ...args], cwd: runCwd, env: env ?? {}, timeoutMs },
        timeoutMs + 10_000,
      );
      if (reply.truncated === true)
        throw new PortError("bad-response", `Remote ${command} output exceeded the relay bound on ${i.host}`);
      if (typeof reply.stdout !== "string" || typeof reply.stderr !== "string" || typeof reply.code !== "number")
        throw new PortError("bad-response", `Relay run returned malformed output on ${i.host}`);
      return { stdout: reply.stdout, stderr: reply.stderr, code: reply.code };
    },
    async realpath(path) {
      const reply = await request("realpath", { path });
      return typeof reply.path === "string" ? reply.path : null;
    },
  };
}

/**
 * The operation's remote `Run` (Ports.run): any argv on the mission host. `anchorWorktree` is the
 * remote repo root when it is a registered Orca worktree (main checkouts are), else a live mission
 * worktree; it only routes the exec — the relay spawns argv at its own cwd.
 */
export function remoteRun(run: Run, cwd: string, i: { host: ExecutionHost; anchorWorktree: string }): Run {
  const relay = remoteRelay(run, cwd, { host: i.host, worktree: i.anchorWorktree });
  return (command, args, runCwd, env) => relay.run(command, args, runCwd, env);
}
