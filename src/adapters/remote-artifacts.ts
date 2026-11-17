// Stage prompts on the mission host and copy produced JSON and session transcripts back.
// Remote paths are absolute paths the relay returned; they are never stat'd on the board.

import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Operation } from "../core/types.ts";
import { PortError, type Run } from "../ports.ts";
import { createRemotePlacement } from "./frontend-orca-remote.ts";
import type { RelayOps } from "./orca-exec.ts";
import { closerReportPath, closerReviewPath, ensureCloserReportDir } from "../store/closer.ts";
import { operationDir } from "../paths.ts";

const CHUNK = 384 * 1024;
const MAX_FILE = 8 * 1024 * 1024;

export interface ArtifactPlacement {
  host: string;
  hostSetup?: string;
  repo: string;
  /** Absolute directory on the mission host. */
  dir: string;
}

export async function relayFor(
  run: Run,
  i: { host: string; hostSetup?: string; repo: string },
): Promise<RelayOps> {
  return createRemotePlacement(run, process.cwd(), {
    host: i.host,
    ...(i.hostSetup ? { hostSetup: i.hostSetup } : {}),
    repo: i.repo,
  }).relay();
}

export function remoteSegment(id: string): string {
  const segment = encodeURIComponent(id);
  if (segment.length === 0 || segment.includes("/") || segment.includes(".."))
    throw new PortError("bad-request", `Refusing remote path segment for "${id}"`);
  return segment;
}

const DRAFT_ID = /^draft-[0-9a-f]{8}$/;
const OP_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Remote JSON and transcripts land only in the board's draft, decision, and closer files. */
export function assertBoardArtifact(home: string, local: string): void {
  const root = resolve(home);
  const target = resolve(local);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new PortError("bad-request", "Refusing to write a remote artifact outside the board home");
  const parts = rel.split(sep);
  const id = parts[1] ?? "";
  const file = parts[3] ?? "";
  const session = parts[4] ?? "";
  const draftSeed = parts.length === 3 && parts[0] === "drafts" && DRAFT_ID.test(id) && parts[2] === "seed.json";
  const draftTranscript = parts.length === 4 && parts[0] === "drafts" && DRAFT_ID.test(id) && parts[2] === "sessions" && file.endsWith(".jsonl") && !file.includes("..");
  const decision = parts.length === 4 && parts[0] === "operations" && OP_ID.test(id) && parts[2] === "decisions" && file.endsWith(".json") && !file.endsWith(".pane.json");
  const decisionTranscript = parts.length === 5 && parts[0] === "operations" && OP_ID.test(id) && parts[2] === "decisions" && file.endsWith(".sessions") && session.endsWith(".jsonl") && !session.includes("..");
  const closer = parts.length === 4 && parts[0] === "operations" && OP_ID.test(id) && parts[2] === "closer" && file !== "placement.json" && (file.endsWith(".json") || file.endsWith(".md"));
  if (!draftSeed && !draftTranscript && !decision && !decisionTranscript && !closer)
    throw new PortError("bad-request", `Refusing to write a remote artifact to ${local}`);
}

export async function stageText(relay: RelayOps, path: string, text: string, mode = 0o600): Promise<string> {
  const res = await relay.request("write", { path, b64: Buffer.from(text, "utf8").toString("base64"), mode });
  if (typeof res.path !== "string" || !res.path.startsWith("/"))
    throw new PortError("host-unprepared", "Relay did not return an absolute remote path");
  return res.path;
}

export async function stageDir(relay: RelayOps, relativeDir: string): Promise<string> {
  return dirname(await stageText(relay, `${relativeDir}/.keep`, ""));
}

export async function removeRemote(relay: RelayOps, path: string): Promise<void> {
  await relay.request("rm", { path });
}

export async function pullFile(relay: RelayOps, remote: string, local: string, home: string): Promise<"ok" | "missing"> {
  assertBoardArtifact(home, local);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const res = await relay.request("read", { path: remote, offset, maxBytes: CHUNK });
    if (res.missing === true) return "missing";
    if (typeof res.b64 !== "string" || typeof res.bytes !== "number" || typeof res.eof !== "boolean")
      throw new PortError("bad-response", `Relay read of ${remote} returned a malformed body`);
    const buf = Buffer.from(res.b64, "base64");
    if (buf.length !== res.bytes) throw new PortError("bad-response", `Relay read of ${remote} length mismatch`);
    chunks.push(buf);
    offset += buf.length;
    if (offset > MAX_FILE) throw new PortError("bad-response", `Remote file ${remote} exceeds 8 MiB`);
    if (res.eof || buf.length === 0) break;
  }
  const parent = dirname(local);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const resolvedParent = await realpath(parent);
  const root = resolve(home);
  if (resolvedParent !== root && !resolvedParent.startsWith(`${root}${sep}`))
    throw new PortError("bad-request", "Refusing to write a remote artifact through a path that leaves the board home");
  const existing = await lstat(local).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink())
    throw new PortError("bad-request", "Refusing to overwrite a symlinked artifact path");
  await writeFile(local, Buffer.concat(chunks), { mode: 0o600 });
  await chmod(local, 0o600);
  return "ok";
}

/** Copy `*.jsonl` transcripts from a remote session directory into the board-local dir. */
export async function pullSessions(relay: RelayOps, remoteDir: string, localDir: string, home: string): Promise<void> {
  const listed = await relay.request("list", { path: remoteDir });
  if (listed.missing === true) return;
  if (!Array.isArray(listed.entries)) throw new PortError("bad-response", "Relay list returned a malformed directory");
  for (const entry of listed.entries) {
    if (typeof entry !== "object" || entry === null) throw new PortError("bad-response", "Relay list entry is malformed");
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name.endsWith(".jsonl") || row.name.includes("/") || row.name.includes("..")) continue;
    await pullFile(relay, join(remoteDir, row.name), join(localDir, row.name), home);
  }
}

const CLOSER_PLACEMENT = "placement.json";

function placementPath(home: string, opId: string): string {
  return join(operationDir(home, opId), "closer", CLOSER_PLACEMENT);
}

export async function writeCloserPlacement(home: string, opId: string, placed: ArtifactPlacement): Promise<void> {
  await ensureCloserReportDir(home, opId);
  await writeFile(placementPath(home, opId), `${JSON.stringify({ v: 1, ...placed }, null, 2)}\n`, { mode: 0o600 });
}

export async function readCloserPlacement(home: string, opId: string): Promise<ArtifactPlacement | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(placementPath(home, opId), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const doc = raw as Record<string, unknown>;
    if (doc.v !== 1 || typeof doc.host !== "string" || doc.host === "local") return null;
    if (typeof doc.repo !== "string" || typeof doc.dir !== "string" || !doc.dir.startsWith("/")) return null;
    if (doc.hostSetup !== undefined && typeof doc.hostSetup !== "string") return null;
    return {
      host: doc.host,
      ...(typeof doc.hostSetup === "string" ? { hostSetup: doc.hostSetup } : {}),
      repo: doc.repo,
      dir: doc.dir,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Copy a remote closer's report back into the operation directory. Missing files stay missing. */
export async function pullCloser(run: Run, home: string, operation: Operation): Promise<void> {
  const placed = await readCloserPlacement(home, operation.id);
  if (!placed) return;
  const relay = await relayFor(run, placed);
  for (const contact of operation.contacts) {
    if (contact.kind !== "closer") continue;
    const name = encodeURIComponent(contact.ticket);
    await pullFile(relay, join(placed.dir, `${name}.json`), closerReviewPath(home, operation.id, contact.ticket), home);
    await pullFile(relay, join(placed.dir, `${name}.md`), closerReportPath(home, operation.id, contact.ticket), home);
  }
}
