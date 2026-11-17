import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createBoardService } from "../../src/board.ts";
import { closerBrief } from "../../src/core/closer.ts";
import type { Contact } from "../../src/core/types.ts";
import { PortError, type Run } from "../../src/ports.ts";
import type { RelayOps } from "../../src/adapters/orca-exec.ts";
import { assertBoardArtifact, pullFile, pullSessions, stageText } from "../../src/adapters/remote-artifacts.ts";
import { draftDir } from "../../src/paths.ts";
import { closerReportPath, closerReviewPath } from "../../src/store/closer.ts";
import { decisionPath, decisionPrompt, decisionSessionsDir, readDecisionPane, writeDecisionPane } from "../../src/store/decisions.ts";
import { draftPrompt } from "../../src/store/draft-prompts.ts";
import { createDraftDir, readDraftDoc, recordDraftTerminal } from "../../src/store/drafts.ts";
import { operation as operationFixture } from "../helpers.ts";

const RELAY = fileURLToPath(new URL("../../src/adapters/remote-relay.mjs", import.meta.url));
const SECRET = "sk-live-do-not-leak";
const DRAFT = "draft-aabbccdd";

function subprocessRelay(home: string): RelayOps {
  async function request(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = spawn(process.execPath, [RELAY, op], {
      env: { ...process.env, HOME: home, HOLOTABLE_REQ: JSON.stringify(body) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? 1));
    const code = await promise;
    const stdout = Buffer.concat(out).toString("utf8");
    if (code !== 0) throw new PortError("relay", `relay ${op} exit ${code}: ${Buffer.concat(err).toString("utf8") || stdout}`);
    const reply = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
    if (typeof reply.error === "object" && reply.error !== null) {
      const error = reply.error as { code?: string; message?: string };
      throw new PortError(error.code ?? "relay", error.message ?? `relay ${op} failed`);
    }
    return reply;
  }
  return {
    ready: async () => undefined,
    request,
    run: (async () => {
      throw new PortError("relay", "artifact tests do not execute a remote command");
    }) as Run,
    realpath: async () => null,
  };
}

async function isolated(): Promise<{ board: string; host: string; relay: RelayOps; outside: string; cleanup: () => Promise<void> }> {
  const board = await mkdtemp(join(tmpdir(), "holotable-board-"));
  const host = await mkdtemp(join(tmpdir(), "holotable-host-"));
  const outside = await mkdtemp(join(tmpdir(), "holotable-outside-"));
  return {
    board,
    host,
    outside,
    relay: subprocessRelay(host),
    cleanup: async () => {
      await rm(board, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

function privateMode(mode: number): void {
  expect(mode & 0o077).toBe(0);
}

describe("relay artifact subprocess", () => {
  test("empty and missing reads stay distinct, and a read is clamped to 384 KiB", async () => {
    const fx = await isolated();
    try {
      const empty = await stageText(fx.relay, `drafts/${DRAFT}/seed.json`, "");
      const readEmpty = await fx.relay.request("read", { path: empty, offset: 0, maxBytes: 1024 });
      expect(readEmpty).toMatchObject({ b64: "", bytes: 0, eof: true });
      expect(readEmpty.missing).toBeUndefined();
      expect(await pullFile(fx.relay, empty, join(fx.board, "drafts", DRAFT, "seed.json"), fx.board)).toBe("ok");
      expect(await readFile(join(fx.board, "drafts", DRAFT, "seed.json"), "utf8")).toBe("");
      expect(await pullFile(fx.relay, `${empty}.absent`, join(fx.board, "drafts", DRAFT, "sessions", "gone.jsonl"), fx.board)).toBe("missing");
      await expect(stat(join(fx.board, "drafts", DRAFT, "sessions", "gone.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

      const bulky = Buffer.alloc(400 * 1024, 7);
      await mkdir(join(fx.host, ".holotable", "drafts", DRAFT), { recursive: true });
      await writeFile(join(fx.host, ".holotable", "drafts", DRAFT, "seed.json"), bulky);
      const clamped = await fx.relay.request("read", { path: empty, offset: 0, maxBytes: 8 * 1024 * 1024 });
      expect(clamped.bytes).toBe(384 * 1024);
      expect(clamped.eof).toBe(false);
      expect(Buffer.from(String(clamped.b64), "base64")).toHaveLength(384 * 1024);
    } finally {
      await fx.cleanup();
    }
  });

  test("a symlink out of the relay root is refused and does not leak or delete the target", async () => {
    const fx = await isolated();
    try {
      const secret = join(fx.outside, "secret.json");
      await writeFile(secret, SECRET, { mode: 0o600 });
      const root = join(fx.host, ".holotable", "drafts", DRAFT);
      await mkdir(root, { recursive: true });
      const link = join(root, "seed.json");
      await symlink(secret, link);
      await expect(fx.relay.request("read", { path: link })).rejects.toMatchObject({ code: "bad-request" });
      await expect(fx.relay.request("rm", { path: link })).rejects.toMatchObject({ code: "bad-request" });
      expect(await readFile(secret, "utf8")).toBe(SECRET);
      const escaped = join(fx.host, ".holotable", "drafts", "escaped");
      await symlink(fx.outside, escaped);
      await expect(fx.relay.request("list", { path: escaped })).rejects.toMatchObject({ code: "bad-request" });
      expect(await readFile(secret, "utf8")).toBe(SECRET);
    } finally {
      await fx.cleanup();
    }
  });

  test("pull copies only known draft, decision, and closer files, privately, and refuses every other board path", async () => {
    const fx = await isolated();
    try {
      const remoteDraft = await stageText(fx.relay, `drafts/${DRAFT}/seed.json`, `{"token":"${SECRET}"}`);
      await stageText(fx.relay, `drafts/${DRAFT}/notes.txt`, SECRET);
      const transcript = `{"secret":"${SECRET}"}\n`;
      const remoteTranscript = await stageText(fx.relay, `drafts/${DRAFT}/sessions/one.jsonl`, transcript);
      await stageText(fx.relay, `drafts/${DRAFT}/sessions/skip.txt`, SECRET);
      const outsideTranscript = join(fx.outside, "leaked.jsonl");
      await writeFile(outsideTranscript, SECRET, { mode: 0o600 });
      await symlink(outsideTranscript, join(fx.host, ".holotable", "drafts", DRAFT, "sessions", "evil.jsonl"));
      const remoteSessions = remoteTranscript.slice(0, remoteTranscript.lastIndexOf("/"));
      const sessions = await fx.relay.request("list", { path: remoteSessions });
      const names = (sessions.entries as { name: string; size: number }[]).map((entry) => entry.name).sort();
      expect(names).toEqual(["one.jsonl", "skip.txt"]);
      expect((sessions.entries as { name: string; size: number }[]).find((entry) => entry.name === "one.jsonl")?.size).toBe(Buffer.byteLength(transcript));

      const localSeed = join(fx.board, "drafts", DRAFT, "seed.json");
      expect(await pullFile(fx.relay, remoteDraft, localSeed, fx.board)).toBe("ok");
      expect(await readFile(localSeed, "utf8")).toContain(SECRET);
      privateMode((await stat(localSeed)).mode);
      await pullSessions(fx.relay, remoteSessions, join(fx.board, "drafts", DRAFT, "sessions"), fx.board);
      expect(await readFile(join(fx.board, "drafts", DRAFT, "sessions", "one.jsonl"), "utf8")).toContain(SECRET);
      await expect(stat(join(fx.board, "drafts", DRAFT, "sessions", "skip.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(fx.board, "drafts", DRAFT, "sessions", "evil.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(outsideTranscript, "utf8")).toBe(SECRET);
      privateMode((await stat(join(fx.board, "drafts", DRAFT, "sessions", "one.jsonl"))).mode);
      privateMode((await stat(remoteDraft)).mode);

      const remoteDecision = await stageText(fx.relay, "ops/lab/decisions/CHR-1.json", `{"choice":"yes","token":"${SECRET}"}`);
      await pullFile(fx.relay, remoteDecision, decisionPath(fx.board, "lab", "CHR-1"), fx.board);
      const remoteCloser = await stageText(fx.relay, "ops/lab/closer/close.json", `{"token":"${SECRET}"}`);
      await pullFile(fx.relay, remoteCloser, closerReviewPath(fx.board, "lab", "close"), fx.board);
      await pullFile(fx.relay, remoteCloser, closerReportPath(fx.board, "lab", "close"), fx.board);
      expect(await readFile(decisionPath(fx.board, "lab", "CHR-1"), "utf8")).toContain(SECRET);
      expect(await readFile(closerReviewPath(fx.board, "lab", "close"), "utf8")).toContain(SECRET);

      const sentinel = join(fx.board, "operations", "lab", "operation.json");
      await mkdir(join(fx.board, "operations", "lab"), { recursive: true });
      await writeFile(sentinel, "keep-me", { mode: 0o600 });
      const pane = join(fx.board, "operations", "lab", "decisions", "CHR-1.pane.json");
      await mkdir(join(fx.board, "operations", "lab", "decisions"), { recursive: true });
      await writeFile(pane, "pane-keep", { mode: 0o600 });
      await expect(pullFile(fx.relay, remoteDecision, sentinel, fx.board)).rejects.toBeInstanceOf(PortError);
      await expect(pullFile(fx.relay, remoteDecision, pane, fx.board)).rejects.toBeInstanceOf(PortError);
      await expect(pullFile(fx.relay, remoteDecision, join(fx.board, "operations", "lab", "closer", "placement.json"), fx.board)).rejects.toBeInstanceOf(PortError);
      await expect(pullFile(fx.relay, remoteDecision, join(fx.outside, "stolen.json"), fx.board)).rejects.toBeInstanceOf(PortError);
      expect(await readFile(sentinel, "utf8")).toBe("keep-me");
      expect(await readFile(pane, "utf8")).toBe("pane-keep");
      await expect(stat(join(fx.outside, "stolen.json"))).rejects.toMatchObject({ code: "ENOENT" });

      const planted = join(fx.board, "drafts", DRAFT, "sessions", "planted.jsonl");
      await symlink(sentinel, planted);
      await expect(pullFile(fx.relay, remoteDecision, planted, fx.board)).rejects.toMatchObject({ code: "bad-request" });
      expect(await readFile(sentinel, "utf8")).toBe("keep-me");

      const huge = join(fx.host, ".holotable", "drafts", DRAFT, "seed.json");
      await writeFile(huge, Buffer.alloc(8 * 1024 * 1024 + 1, 1));
      await expect(pullFile(fx.relay, huge, localSeed, fx.board)).rejects.toMatchObject({ code: "bad-response" });
      expect(await readFile(localSeed, "utf8")).toContain(SECRET);
      expect((await stat(localSeed)).size).toBeLessThan(1024);
    } finally {
      await fx.cleanup();
    }
  });
});


describe("auxiliary payload and host identity", () => {
  test("local and remote drafts, decisions, and closer briefs share one payload except the output path", () => {
    const home = "/board";
    const localDraft = draftPrompt(home, DRAFT);
    const remoteDraft = draftPrompt(home, DRAFT, "/host/drafts/draft-aabbccdd");
    expect(remoteDraft).toBe(localDraft.replaceAll(draftDir(home, DRAFT), "/host/drafts/draft-aabbccdd"));
    expect(remoteDraft).toContain("/host/drafts/draft-aabbccdd/seed.json");
    expect(remoteDraft).not.toContain(draftDir(home, DRAFT));

    const contact = { ticket: "CHR-1", title: "Choose", zone: "z", kind: "decision", blockedBy: [], conflictOf: null, lane: null } as Contact;
    const localDecision = decisionPrompt({ home, opId: "lab", contact, brief: "brief", notes: null, decided: [] });
    const remoteDecision = decisionPrompt({ home, opId: "lab", contact, brief: "brief", notes: null, decided: [], out: "/host/ops/CHR-1.json" });
    expect(remoteDecision).toBe(localDecision.replaceAll(decisionPath(home, "lab", "CHR-1"), "/host/ops/CHR-1.json"));

    const closer = { ticket: "close", title: null, zone: "z", kind: "closer", blockedBy: [], conflictOf: null, lane: null } as Contact;
    const operation = operationFixture({ id: "lab", name: "Lab", repo: "/repo", base: "main", integration: "/repo", delivery: "none", contacts: [closer], zones: [] });
    const input = { operation, closer, events: [], briefText: null, notesText: null, recommendations: [] };
    const localCloser = closerBrief({ ...input, reportPath: closerReviewPath(home, "lab", "close"), markdownPath: closerReportPath(home, "lab", "close") });
    const remoteCloser = closerBrief({ ...input, reportPath: "/host/ops/close.json", markdownPath: "/host/ops/close.md" });
    expect(remoteCloser).toBe(
      localCloser
        .replaceAll(closerReviewPath(home, "lab", "close"), "/host/ops/close.json")
        .replaceAll(closerReportPath(home, "lab", "close"), "/host/ops/close.md"),
    );
    expect(decisionSessionsDir(home, "lab", "CHR-1")).toContain("CHR-1.sessions");
  });

  test("draft and decision host fields persist, and close refuses a terminal on another host", async () => {
    const home = await mkdtemp(join(tmpdir(), "holotable-identity-"));
    try {
      await createDraftDir(home, DRAFT, {
        text: "idea",
        repo: "/remote/repo",
        frontend: "orca",
        tracker: "none",
        createdAt: "2026-01-02T03:04:05.000Z",
        host: "ssh:box",
        hostSetup: "setup-1",
        remoteDir: "/remote/drafts/draft-aabbccdd",
      });
      await recordDraftTerminal(home, DRAFT, { handle: "pane", incarnationId: "inc", host: "ssh:other", worktreeId: "wt" });
      const doc = await readDraftDoc(home, DRAFT);
      expect(doc).toMatchObject({
        createdAt: "2026-01-02T03:04:05.000Z",
        host: "ssh:box",
        hostSetup: "setup-1",
        remoteDir: "/remote/drafts/draft-aabbccdd",
        terminal: { handle: "pane", incarnationId: "inc", host: "ssh:other", worktreeId: "wt" },
      });
      const svc = createBoardService(home);
      await expect(svc.closeDraft(DRAFT)).rejects.toMatchObject({ status: 409 });
      expect(await readDraftDoc(home, DRAFT)).not.toBeNull();

      await writeDecisionPane(home, "lab", "CHR-1", {
        terminal: { handle: "pane", incarnationId: "1", host: "ssh:box", worktreeId: "wt" },
        startedAt: "2026-01-02T03:04:05.000Z",
        host: "ssh:box",
        hostSetup: "setup-1",
        remoteAnswer: "/host/ops/CHR-1.json",
        remoteSessions: "/host/ops/CHR-1.sessions",
      });
      expect(await readDecisionPane(home, "lab", "CHR-1")).toMatchObject({
        host: "ssh:box",
        hostSetup: "setup-1",
        remoteAnswer: "/host/ops/CHR-1.json",
        remoteSessions: "/host/ops/CHR-1.sessions",
        terminal: { host: "ssh:box", worktreeId: "wt" },
      });
      expect(() => assertBoardArtifact(home, join(home, "operations", "lab", "operation.json"))).toThrow(PortError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
