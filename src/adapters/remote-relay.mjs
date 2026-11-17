// Holotable remote mission relay. Deployed to <home>/.holotable/holotable-relay-<sha>.mjs on the
// mission host and invoked non-interactively through `orca worktree exec`. Runs under bun, node
// (ESM), or the compiled omp binary (`BUN_BE_BUN=1 omp relay.mjs`). One request per invocation:
// op from argv[2], request JSON from env HOLOTABLE_REQ, one JSON result line on stdout.
// Exit code 0 with {error:{code,message}} means the op answered; nonzero means the relay failed.
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";

const VERSION = 1;
const MAX_LINE_BYTES = 1024 * 1024;
// Combined relay stdout+stderr stays under the 3MiB `worktree exec` bound (orca-exec.ts) with room
// for the JSON envelope; callers re-request narrower output rather than losing the whole exec.
const MAX_OUTPUT_BYTES = 1024 * 1024;

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function fail(code, message) {
  out({ error: { code, message } });
}
function req() {
  const raw = process.env.HOLOTABLE_REQ;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

// Newline-delimited JSON: one request line, one response line, close. Never half-close (Bun drops
// a reply arriving after end()). Mirrors the board's socketRequest in fleet-omp-mission.ts.
function socketRequest(path, payload, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect(path);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ error: { code: "owner-offline", message: `Timed out connecting to ${path}` } }),
      timeoutMs,
    );
    let buffer = "";
    let bytes = 0;
    socket.on("error", (error) =>
      finish({ error: { code: "owner-offline", message: `${error.code ?? "socket error"}: ${error.message}` } }),
    );
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      bytes += chunk.length;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (bytes > MAX_LINE_BYTES)
          finish({ error: { code: "bad-response", message: `Response from ${path} exceeds ${MAX_LINE_BYTES} bytes` } });
        return;
      }
      const line = buffer.slice(0, newline);
      try {
        finish({ reply: JSON.parse(line) });
      } catch (error) {
        finish({ error: { code: "bad-response", message: `Unparseable response from ${path}: ${error.message}` } });
      }
    });
    socket.on("close", () => {
      if (!done) finish({ error: { code: "owner-offline", message: `Socket ${path} closed without a reply` } });
    });
  });
}

// A tracked status file proves board ownership; revive-eligible missions need the <id>.ctl marker
// beside the status file so the owner serves its control socket (fleet-omp-mission.ts parity).
async function backfillCtlMarker(statusPath) {
  const marker = join(dirname(statusPath), `${basename(statusPath, ".json")}.ctl`);
  await writeFile(marker, `${process.pid}\n`, { mode: 0o600, flag: "wx" }).catch(() => undefined);
}

// Scan <agentDir>/missions/*/status/*.json for files whose status.worktree resolves to the wanted
// path. Returns raw parsed statuses + mtimes; the board validates and picks the newest.
async function statusScan(r) {
  const worktree = typeof r.worktree === "string" ? r.worktree : null;
  if (!worktree) return fail("bad-request", "status needs worktree");
  const wanted = await realpath(worktree).catch(() => null);
  if (wanted === null) return out({ candidates: [] });
  const agentDir =
    typeof r.agentDir === "string" && r.agentDir.length > 0
      ? r.agentDir
      : (process.env.PI_CODING_AGENT_DIR || process.env.OMP_AGENT_DIR || join(homedir(), ".omp", "agent"));

  const root = join(agentDir, "missions");
  let workspaces;
  try {
    workspaces = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === "ENOENT") return out({ candidates: [] });
    return fail("relay", `Cannot read ${root}: ${error.message}`);
  }
  const candidates = [];
  for (const workspace of workspaces) {
    const directory = join(root, workspace, "status");
    let names;
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const path = join(directory, name);
      let meta;
      let status;
      try {
        meta = await stat(path);
        status = JSON.parse(await readFile(path, "utf8"));
      } catch {
        continue;
      }
      if (typeof status?.worktree !== "string") continue;
      const real = await realpath(status.worktree).catch(() => null);
      if (real !== wanted) continue;
      await backfillCtlMarker(path);
      candidates.push({ path, mtimeMs: meta.mtimeMs, status });
    }
  }
  return out({ candidates });
}

async function ctl(r) {
  const socket = typeof r.socket === "string" ? r.socket : null;
  const payload = typeof r.payload === "object" && r.payload !== null ? r.payload : null;
  const timeoutMs = typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? Math.min(r.timeoutMs, 170_000) : 3_000;
  if (!socket || !payload) return fail("bad-request", "ctl needs socket and payload");
  return out(await socketRequest(socket, payload, timeoutMs));
}

// /proc/<pid>/stat field 22: a reused pid gives a different start-time, never a false positive.
async function proc(r) {
  const pid = r.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return out({ start: null });
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    return out({ start: statText.slice(statText.lastIndexOf(")") + 2).split(" ")[19] ?? null });
  } catch (error) {
    // No /proc (non-Linux host): report unsupported so the board returns null, never a false dead.
    if (error && error.code === "ENOENT") {
      const self = await readFile("/proc/self/stat", "utf8").catch(() => null);
      if (self === null) return out({ supported: false, start: null });
    }
    return out({ start: null });
  }
}
function underHolotable(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/")) return null;
  const root = join(homedir(), ".holotable");
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "..")) return null;
  const path = `/${parts.join("/")}`;
  if (path !== root && !path.startsWith(`${root}/`)) return null;
  return path;
}

// Bounded read of a staged artifact. Callers page with offset; one reply stays under the 1MiB exec bound.
async function read(r) {
  const path = underHolotable(r.path);
  if (!path) return fail("bad-request", "read needs an absolute path under ~/.holotable");
  const offset = Number.isInteger(r.offset) && r.offset >= 0 ? r.offset : 0;
  const maxBytes = Number.isInteger(r.maxBytes) && r.maxBytes > 0 ? Math.min(r.maxBytes, 384 * 1024) : 384 * 1024;
  const root = join(homedir(), ".holotable");
  let resolved;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return out({ missing: true });
    return fail("relay", `Cannot read ${path}: ${error.message}`);
  }
  if (resolved !== root && !resolved.startsWith(`${root}/`))
    return fail("bad-request", "read path escapes ~/.holotable");
  let fh;
  try {
    fh = await open(resolved, "r");
    const info = await fh.stat();
    const len = Math.min(maxBytes, Math.max(0, info.size - offset));
    const buf = Buffer.alloc(len);
    let bytes = 0;
    while (bytes < len) {
      const chunk = await fh.read(buf, bytes, len - bytes, offset + bytes);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
    }
    return out({ b64: buf.subarray(0, bytes).toString("base64"), bytes, size: info.size, eof: offset + bytes >= info.size });
  } catch (error) {
    if (error && error.code === "ENOENT") return out({ missing: true });
    return fail("relay", `Cannot read ${path}: ${error.message}`);
  } finally {
    await fh?.close();
  }
}

async function list(r) {
  const path = underHolotable(r.path);
  if (!path) return fail("bad-request", "list needs an absolute path under ~/.holotable");
  const root = join(homedir(), ".holotable");
  try {
    const resolved = await realpath(path);
    if (resolved !== root && !resolved.startsWith(`${root}/`))
      return fail("bad-request", "list path escapes ~/.holotable");
    const names = await readdir(path);
    const entries = [];
    for (const name of names) {
      if (name.includes("/") || name === ".." || name === "." || name.includes("..")) continue;
      const info = await lstat(join(path, name));
      if (!info.isFile()) continue;
      entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    return out({ entries });
  } catch (error) {
    if (error && error.code === "ENOENT") return out({ missing: true });
    return fail("relay", `Cannot list ${path}: ${error.message}`);
  }
}

// Only staged draft and operation artifacts. A relay rm of an arbitrary host path is not this op.
async function remove(r) {
  const path = underHolotable(r.path);
  const root = join(homedir(), ".holotable");
  const rel = path ? path.slice(root.length + 1) : "";
  if (!path || path === root || (!rel.startsWith("drafts/") && !rel.startsWith("ops/")))
    return fail("bad-request", "rm is limited to ~/.holotable/drafts and ~/.holotable/ops");
  try {
    const resolved = await realpath(path).catch(() => path);
    if (resolved !== root && !resolved.startsWith(`${root}/`))
      return fail("bad-request", "rm path escapes ~/.holotable");
    await rm(path, { recursive: true, force: true });
    return out({ ok: true });
  } catch (error) {
    return fail("relay", `Cannot remove ${path}: ${error.message}`);
  }
}

async function write(r) {
  const raw = typeof r.path === "string" ? r.path : null;
  const b64 = typeof r.b64 === "string" ? r.b64 : null;
  if (!raw || b64 === null) return fail("bad-request", "write needs path and b64");
  // Bare names land under ~/.holotable (overlays, launch scripts); absolute paths stay absolute.
  const path = raw.startsWith("/") ? raw : join(homedir(), ".holotable", raw);
  const mode = Number.isInteger(r.mode) ? r.mode : 0o600;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.from(b64, "base64"), { mode });
    return out({ ok: true, path });
  } catch (error) {
    return fail("relay", `Cannot write ${path}: ${error.message}`);
  }
}

// A bounded remote Run: argv never passes a shell; env replaces nothing the caller did not name.
async function runCmd(r) {
  const argv = Array.isArray(r.argv) && r.argv.every((a) => typeof a === "string") ? r.argv : null;
  const cwd = typeof r.cwd === "string" ? r.cwd : null;
  if (!argv || argv.length === 0 || !cwd) return fail("bad-request", "run needs argv and cwd");
  const env = { ...process.env };
  if (typeof r.env === "object" && r.env !== null)
    for (const [key, value] of Object.entries(r.env)) if (typeof value === "string") env[key] = value;
  const timeoutMs = typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? Math.min(r.timeoutMs, 170_000) : 60_000;
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env });
    } catch (error) {
      return resolve(out({ stdout: "", stderr: String(error), code: 127 }));
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = (current, chunk) => {
      const next = current + chunk;
      if (next.length <= MAX_OUTPUT_BYTES) return next;
      truncated = true;
      return next.slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout?.on("data", (chunk) => (stdout = cap(stdout, chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk) => (stderr = cap(stderr, chunk.toString("utf8"))));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out({ stdout, stderr: `${stderr}\n[holotable-relay] timed out after ${timeoutMs}ms`, code: 124, truncated }));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(out({ stdout, stderr: String(error), code: 127, truncated }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(out({ stdout, stderr, code: code ?? 1, truncated }));
    });
  });
}

const op = process.argv[2];
const r = req();
try {
  if (op === "ping") out({ ok: true, version: VERSION });
  else if (!r) fail("bad-request", "HOLOTABLE_REQ is missing or invalid JSON");
  else if (op === "status") await statusScan(r);
  else if (op === "ctl") await ctl(r);
  else if (op === "proc") await proc(r);
  else if (op === "realpath") out({ path: typeof r.path === "string" ? await realpath(r.path).catch(() => null) : null });
  else if (op === "write") await write(r);
  else if (op === "read") await read(r);
  else if (op === "list") await list(r);
  else if (op === "rm") await remove(r);
  else if (op === "run") await runCmd(r);
  else fail("bad-request", `unknown op ${String(op)}`);
} catch (error) {
  fail("relay", String(error && error.message ? error.message : error));
}
