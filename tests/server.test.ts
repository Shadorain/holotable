import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardService, type BoardHooks } from "../src/board.ts";
import type { Operation } from "../src/core/types.ts";
import { ActionError } from "../src/runtime/errors.ts";
import { endOperation } from "../src/runtime/end.ts";
import { startServer, type BoardServer } from "../src/server.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { archiveDir, operationDir } from "../src/paths.ts";
import { appendEvent } from "../src/store/events.ts";
import { archiveOperation, createOperation } from "../src/store/operations.ts";
import { createProject } from "../src/store/projects.ts";
import { fakePorts, noRun } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function operation(over: Partial<Operation> = {}): Operation {
  return {
    v: 1,
    id: "lab",
    name: "Lab",
    repo: "/tmp/lab",
    base: "main",
    integration: "/tmp/lab",
    pause: true,
    ignoreChecks: false,
    tracker: "none",
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "none",
    zones: [{ id: "ops", label: "Ops" }],
    contacts: [
      { ticket: "a", title: "First", zone: "ops", kind: "implement", blockedBy: [], conflictOf: null, lane: null },
      { ticket: "b", title: null, zone: "ops", kind: "implement", blockedBy: ["a"], conflictOf: null, lane: null },
      { ticket: "n", title: null, zone: "ops", kind: "decision", blockedBy: [], conflictOf: null, lane: null },
    ],
    project: null,
    recover: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

async function boot(hooks: BoardHooks = {}) {
  const home = mkdtempSync(join(tmpdir(), "holotable-srv-"));
  await createOperation(home, operation());
  for (const contact of ["a", "b", "n"])
    await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:00:00.000Z", kind: "queued", contact });
  const server: BoardServer = await startServer({ service: createBoardService(home, hooks), settings: { access: "local", port: 0 } });
  cleanup.push(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });
  const url = new URL(server.url);
  const token = url.hash.slice(1);
  const base = `${url.protocol}//${url.host}`;
  const api = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { "x-holotable-token": token, ...(init.method && init.method !== "GET" ? { origin: base, "content-type": "application/json" } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  return { home, base, token, api };
}

test("api rejects a missing or wrong token", async () => {
  const { base, api } = await boot();
  expect((await fetch(`${base}/api/operations`)).status).toBe(401);
  expect((await api("/api/operations", { headers: { "x-holotable-token": "nope" } })).status).toBe(401);
  expect((await api("/api/operations")).status).toBe(200);
});

test("a foreign Host header is refused", async () => {
  const { base, token } = await boot();
  const port = new URL(base).port;
  // fetch() forbids overriding Host, so speak HTTP directly.
  const res = await new Promise<number>((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () =>
      socket.write(`GET /api/operations HTTP/1.1\r\nHost: evil.example\r\nx-holotable-token: ${token}\r\nConnection: close\r\n\r\n`),
    );
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(Number(data.split(" ")[1])));
    socket.on("error", reject);
  });
  expect(res).toBe(403);
});

test("POST from another origin is refused", async () => {
  const { base, token, api } = await boot();
  const res = await api("/api/refresh", { method: "POST", body: { op: "lab" }, headers: { origin: "http://evil.example" } });
  expect(res.status).toBe(403);
  expect((await api("/api/refresh", { method: "POST", body: { op: "lab" } })).status).toBe(200);
  const noOrigin = await fetch(`${base}/api/refresh`, { method: "POST", headers: { "x-holotable-token": token }, body: JSON.stringify({ op: "lab" }) });
  expect(noOrigin.status).toBe(403);
});

test("stream requires header auth and delivers committed changes", async () => {
  const { home, base, token } = await boot();
  expect((await fetch(`${base}/api/stream?token=${token}`)).status).toBe(401);
  expect((await fetch(`${base}/api/operations?token=${token}`)).status).toBe(401);
  const res = await fetch(`${base}/api/stream`, { headers: { "x-holotable-token": token } });
  const reader = res.body!.getReader();
  try {
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(": ready");
    await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:00:01.000Z", kind: "operator", contact: "a", op: "refresh", ok: true });
    expect(decoder.decode((await reader.read()).value)).toContain('"changed"');
  } finally {
    await reader.cancel();
  }
});

test("stream notifies other clients after a notes-only mutation", async () => {
  const { base, token, api } = await boot();
  const response = await api("/api/stream");
  const reader = response.body!.getReader();
  try {
    await reader.read();
    const notes = await (await api("/api/notes?op=lab")).json() as { revision: string };
    const saved = await api("/api/notes", { method: "PUT", body: { op: "lab", text: "- [ ] Changed", base: notes.revision } });
    expect(saved.status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"changed"');
  } finally {
    await reader.cancel();
  }
});

test("shutdown terminates an open stream without waiting for its client", async () => {
  const { api } = await boot();
  const close = cleanup.pop()!;
  const response = await api("/api/stream");
  const reader = response.body!.getReader();
  await reader.read();
  const ended = reader.read().then(chunk => chunk.done, () => true);
  await close();
  expect(await ended).toBe(true);
});

test("projection groups contacts and selects the first queued one", async () => {
  const { api } = await boot();
  const list = (await (await api("/api/operations")).json()) as Array<{ id: string; name: string; project: string | null; live: number; queued: number; attention: number }>;
  expect(list).toEqual([{ id: "lab", name: "Lab", project: null, live: 0, queued: 3, attention: 1 }]);
  const projection = (await (await api("/api/projection?op=lab")).json()) as {
    selection: string | null;
    contacts: Array<{ ticket: string; group: string; state: string }>;
  };
  expect(projection.contacts.map((c) => [c.ticket, c.group, c.state])).toEqual([
    ["a", "queue", "ready"],
    ["b", "queue", "blocked"],
    ["n", "queue", "decision"],
  ]);
  expect(projection.selection).toBe("a");
  expect((await api("/api/projection?op=ghost")).status).toBe(404);
  expect((await api("/api/projection")).status).toBe(400);
});

test("assets are served and a missing one is a 404, not a crash", async () => {
  const { base } = await boot();
  expect((await fetch(`${base}/nonsense`)).status).toBe(404);
  const index = await fetch(`${base}/`);
  expect([200, 404]).toContain(index.status);
});

test("actions: refused as unavailable without a runtime", async () => {
  const { api } = await boot();
  const res = await api("/api/actions", { method: "POST", body: { op: "lab", contact: "a", action: "launch" } });
  expect(res.status).toBe(404);
});

test("actions: server recomputes legality and passes enabled actions through", async () => {
  const calls: unknown[] = [];
  const { api } = await boot({ action: async (req) => void calls.push(req) });
  const blocked = await api("/api/actions", { method: "POST", body: { op: "lab", contact: "b", action: "launch" } });
  expect(blocked.status).toBe(409);
  const refusal: { error: string } = await blocked.json();
  expect(refusal.error).toBe("blocked by a");
  expect((await api("/api/actions", { method: "POST", body: { op: "lab", contact: "a", action: "land" } })).status).toBe(409);
  expect((await api("/api/actions", { method: "POST", body: { op: "lab", contact: "ghost", action: "launch" } })).status).toBe(404);
  expect(calls).toEqual([]);
  const ok = await api("/api/actions", { method: "POST", body: { op: "lab", contact: "a", action: "launch", args: { x: 1 } } });
  expect(ok.status).toBe(200);
  expect(calls).toEqual([{ op: "lab", contact: "a", action: "launch", args: { x: 1 } }]);
});

test("refresh runs the watcher hook for a known operation only", async () => {
  const refreshed: string[] = [];
  const { api } = await boot({ refresh: async (id) => void refreshed.push(id) });
  expect((await api("/api/refresh", { method: "POST", body: { op: "lab" } })).status).toBe(200);
  expect((await api("/api/refresh", { method: "POST", body: { op: "ghost" } })).status).toBe(404);
  expect(refreshed).toEqual(["lab"]);
});

test("oversized and malformed bodies are rejected", async () => {
  const { base, token } = await boot();
  const headers = { "x-holotable-token": token, origin: base, "content-type": "application/json" };
  expect((await fetch(`${base}/api/refresh`, { method: "POST", headers, body: "not json" })).status).toBe(400);
  expect((await fetch(`${base}/api/refresh`, { method: "POST", headers, body: JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024 + 10) }) })).status).toBe(413);
});

test("actions settle mission state before answering, even when the action fails", async () => {
  const settled: string[] = [];
  const { api } = await boot({
    action: async (req) => {
      if (req.contact === "n") throw new Error("boom");
    },
    settle: async (op) => void settled.push(op),
  });
  expect((await api("/api/actions", { method: "POST", body: { op: "lab", contact: "a", action: "launch" } })).status).toBe(200);
  expect((await api("/api/actions", { method: "POST", body: { op: "lab", contact: "n", action: "done" } })).status).toBe(500);
  expect(settled).toEqual(["lab", "lab"]);
});

test("history returns every entry newest first, with who acted", async () => {
  const { api } = await boot();
  const entries = (await (await api("/api/history?op=lab")).json()) as Array<{ contact: string; actor: string; kind: string }>;
  expect(entries.map((e) => e.contact)).toEqual(["n", "b", "a"]);
  expect(entries.every((e) => e.kind === "queued" && e.actor === "operator")).toBe(true);
  expect((await api("/api/history?op=ghost")).status).toBe(404);
});

test("settings: valid changes persist, invalid ones are a 400 with the reason, cross-origin writes are refused", async () => {
  const { api } = await boot();
  const initial = (await (await api("/api/settings")).json()) as { settings: { theme: string; worktrees: { root: string } }; themes: string[] };
  expect(initial.settings.theme).toBe("holo");
  const put = await api("/api/settings", { method: "PUT", body: { key: "theme", value: "omp" } });
  expect(put.status).toBe(200);
  expect(((await (await api("/api/settings")).json()) as { settings: { theme: string } }).settings.theme).toBe("omp");
  const bad = await api("/api/settings", { method: "PUT", body: { key: "worktrees.root", value: "~/lanes" } });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("{name}");
  expect((await api("/api/settings", { method: "PUT", body: { key: "nope", value: "1" } })).status).toBe(400);
  const foreign = await api("/api/settings", { method: "PUT", body: { key: "theme", value: "slate" }, headers: { origin: "http://evil.example" } });
  expect(foreign.status).toBe(403);
});

test("operation config: Orca's project folder decides where Orca lanes go", async () => {
  const calls: string[][] = [];
  let base: string | null = "/srv/lab/.wt";
  const { api } = await boot({
    run: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, result: { repo: { path: "/tmp/lab", worktreeBasePath: base } } }) };
    },
  });
  type Config = { fields: { frontend: string; worktreeRoot: string }; workspace: { path: string | null; source: string; note: string | null } };
  const orca = (await (await api("/api/operation-config?op=lab")).json()) as Config;
  expect(orca.workspace).toMatchObject({ path: "/srv/lab/.wt", source: "orca-project" });
  expect(calls[0]).toEqual(["orca", "repo", "show", "--repo", "path:/tmp/lab", "--json"]);
  base = null;
  const unset = (await (await api("/api/operation-config?op=lab")).json()) as Config;
  expect(unset.workspace.path).toBeNull();
  expect(unset.workspace.note).toContain("Orca's project settings");
});

test("operation config: a per-operation worktree folder overrides the setting and clears back to it", async () => {
  const { api } = await boot();
  type Config = { fields: { frontend: string; worktreeRoot: string }; workspace: { path: string | null; source: string; note: string | null } };
  const post = (field: string, value: string) => api("/api/operation-config", { method: "POST", body: { op: "lab", field, value } });
  let config = (await (await post("frontend", "herdr")).json()) as Config;
  expect(config.workspace).toEqual({ path: "/tmp/lab-holotable-{name}", source: "settings", note: null });
  config = (await (await post("worktreeRoot", "/srv/lanes/{repoName}/{name}")).json()) as Config;
  expect(config.fields.worktreeRoot).toBe("/srv/lanes/{repoName}/{name}");
  expect(config.workspace).toMatchObject({ path: "/srv/lanes/lab/{name}", source: "operation" });
  config = (await (await post("worktreeRoot", "")).json()) as Config;
  expect(config.workspace.source).toBe("settings");
  const bad = await post("frontend", "tmux");
  expect(bad.status).toBe(400);
  expect((await post("contacts", "x")).status).toBe(400);
  expect((await api("/api/operation-config", { method: "POST", body: { op: "ghost", field: "name", value: "x" } })).status).toBe(404);
});

test("POST /api/operations creates an operation; a bad spec is a 400", async () => {
  const { api } = await boot();
  const repo = mkdtempSync(join(tmpdir(), "holotable-repo-"));
  cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
  const created = await api("/api/operations", { method: "POST", body: { id: "ops2", repo, base: "main", seed: JSON.stringify({ zones: [{ id: "z1", label: "Z1" }], contacts: [{ ticket: "t1", zone: "z1" }], brief: "# Brief" }) } });
  expect(created.status).toBe(200);
  expect(await created.json()).toEqual({ id: "ops2" });
  const brief = (await (await api("/api/brief?op=ops2")).json()) as { brief: string | null; seed: { text: string } | null };
  expect(brief.brief).toBe("# Brief");
  expect(brief.seed?.text).toContain('"zones"');
  expect((await api("/api/operations", { method: "POST", body: { id: "bad", repo: "relative/path", base: "main" } })).status).toBe(400);
  expect((await api("/api/operations", { method: "POST", body: { id: "bad", repo: "/nonexistent-dir-xyz", base: "main" } })).status).toBe(400);
  expect((await api("/api/operations", { method: "POST", body: { id: "bad!", repo, base: "main" } })).status).toBe(400);
});

test("POST /api/zones and /api/contacts add to the operation; bad input is a 400", async () => {
  const { api } = await boot();
  const zone = await api("/api/zones", { method: "POST", body: { op: "lab", label: "Second desk" } });
  expect(await zone.json()).toEqual({ id: "second-desk" });
  // The same label again gets its own id rather than colliding.
  expect(await (await api("/api/zones", { method: "POST", body: { op: "lab", label: "Second desk" } })).json()).toEqual({ id: "second-desk-2" });
  const added = await api("/api/contacts", { method: "POST", body: { op: "lab", ticket: "t9", zone: "second-desk", kind: "audit", title: "Audit nine", description: "Audit nine full description" } });
  expect(added.status).toBe(200);
  expect(await added.json()).toEqual({ ticket: "t9" });
  const projection = (await (await api("/api/projection?op=lab")).json()) as { contacts: Array<{ ticket: string; zone: string; kind: string; title: string | null; description: string | null }> };
  expect(projection.contacts.find((c) => c.ticket === "t9")).toMatchObject({ zone: "second-desk", kind: "audit", title: "Audit nine", description: "Audit nine full description" });
  expect((await api("/api/contacts", { method: "POST", body: { op: "lab", ticket: "t10", zone: "second-desk", description: 123 } })).status).toBe(400);
  expect((await api("/api/contacts", { method: "POST", body: { op: "lab", ticket: "t8", zone: "ghost" } })).status).toBe(400);
  expect((await api("/api/zones", { method: "POST", body: { op: "lab", label: "" } })).status).toBe(400);
  expect((await api("/api/contacts", { method: "POST", body: { op: "ghost", ticket: "t1", zone: "ops" } })).status).toBe(404);
});

test("GET/PUT /api/brief round-trips markdown; bad ops are 404", async () => {
  const { api } = await boot();
  const empty = (await (await api("/api/brief?op=lab")).json()) as { brief: string | null; seed: null; createdAt: string };
  expect(empty.brief).toBeNull();
  expect(empty.createdAt).toBe("2026-01-01T00:00:00.000Z");
  expect((await api("/api/brief", { method: "PUT", body: { op: "lab", text: "# Plan of record" } })).status).toBe(200);
  const round = (await (await api("/api/brief?op=lab")).json()) as { brief: string | null };
  expect(round.brief).toBe("# Plan of record");
  expect((await api("/api/brief?op=ghost")).status).toBe(404);
  expect((await api("/api/brief", { method: "PUT", body: { op: "lab" } })).status).toBe(400);
});

test("GET /api/plan 404s without a fleet hook; operation endpoint carries brief and seed", async () => {
  const { api } = await boot();
  expect((await api("/api/plan?op=lab&contact=a")).status).toBe(404);
  const view = (await (await api("/api/operation?op=lab")).json()) as { cfg: { fields: { name: string } }; brief: string | null; seed: null; createdAt: string };
  expect(view.cfg.fields.name).toBe("Lab");
  expect(view.brief).toBeNull();
  expect(view.createdAt).toBe("2026-01-01T00:00:00.000Z");
});

test("GET /api/plan proxies the fleet hook and 404s on no plan", async () => {
  const { api } = await boot({ plan: async (op, ticket) => (ticket === "a" ? { text: "# Plan", path: "/p.md", revision: "r1" } : null) });
  const plan = (await (await api("/api/plan?op=lab&contact=a")).json()) as { text: string };
  expect(plan.text).toBe("# Plan");
  expect((await api("/api/plan?op=lab&contact=b")).status).toBe(404);
  expect((await api("/api/plan?op=lab")).status).toBe(400);
});

test("archive routes: list newest first, report with history, traversal and unknown keys are 404", async () => {
  const { home, api } = await boot();
  // Two archives: one with report.json (written by the real end path), one without (built on read).
  const fake = fakePorts();
  await endOperation({ home, now: () => new Date("2026-01-04T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, run: noRun }, "lab", "abandoned");
  await createOperation(home, operation({ id: "old", name: "Old", contacts: [] }));
  await appendEvent(home, "old", { v: 1, at: "2026-01-02T00:00:00.000Z", kind: "closed", outcome: "failed" });
  await archiveOperation(home, "old", new Date("2026-01-03T00:00:00Z"));

  const list = (await (await api("/api/archive")).json()) as Array<{ key: string; id: string; outcome: string; closedAt: string }>;
  expect(list.map((r) => r.id)).toEqual(["lab", "old"]); // newest close first
  expect(list[0].outcome).toBe("abandoned");
  expect(list[1].outcome).toBe("failed");

  const detail = (await (await api(`/api/archive/report?key=${list[0].key}`)).json()) as { report: { outcome: string; counts: { contacts: number } }; history: Array<{ kind: string }> };
  expect(detail.report.outcome).toBe("abandoned");
  expect(detail.report.counts.contacts).toBe(3);
  expect(detail.history.map((h) => h.kind)).toContain("closed");

  expect((await api(`/api/archive/report?key=${encodeURIComponent("../lab")}`)).status).toBe(404);
  expect((await api("/api/archive/report?key=nothing")).status).toBe(404);
  expect((await api("/api/archive/report")).status).toBe(400);
});

test("abort: wrong confirm is a 400, right confirm runs the end hook and returns the archive key", async () => {
  const { api } = await boot({
    end: {
      preview: async () => ({ terminals: ["a"], worktrees: [{ ticket: "a", path: "/wt/a", dirty: true }], live: 1, queued: 2, landed: 0 }),
      abort: async (opId, confirm) => {
        if (confirm !== opId) throw new ActionError(400, "confirm", "confirm must be the operation id");
        return { archived: `${opId}-20260102030405` };
      },
      close: async (opId, outcome) => ({ archived: `${opId}-x` }),
    },
  });
  const preview = (await (await api("/api/abort-preview?op=lab")).json()) as { terminals: string[]; worktrees: Array<{ dirty: boolean }> };
  expect(preview.terminals).toEqual(["a"]);
  expect(preview.worktrees[0].dirty).toBe(true);
  expect((await api("/api/abort-preview?op=missing")).status).toBe(404);

  const wrong = await api("/api/abort", { method: "POST", body: { op: "lab", confirm: "nope" } });
  expect(wrong.status).toBe(400);
  const wrongBody = (await wrong.json()) as { error: string };
  expect(wrongBody.error).toContain("confirm must be the operation id");

  const ok = (await (await api("/api/abort", { method: "POST", body: { op: "lab", confirm: "lab" } })).json()) as { archived: string };
  expect(ok.archived).toBe("lab-20260102030405");

  const closed = (await (await api("/api/close", { method: "POST", body: { op: "lab", outcome: "landed" } })).json()) as { archived: string };
  expect(closed.archived).toBe("lab-x");
  expect((await api("/api/close", { method: "POST", body: { op: "lab", outcome: "bogus" } })).status).toBe(400);
  expect((await api("/api/abort-preview?op=lab")).status).toBe(200);
});

test("end routes are 404 without a wind-down runtime", async () => {
  const { api } = await boot();
  expect((await api("/api/abort-preview?op=lab")).status).toBe(404);
  expect((await api("/api/abort", { method: "POST", body: { op: "lab", confirm: "lab" } })).status).toBe(404);
  expect((await api("/api/close", { method: "POST", body: { op: "lab", outcome: "landed" } })).status).toBe(404);
});

test("tracker search: flags taken hits, short-circuits short queries and none, 404s unknown targets", async () => {
  const fake = fakePorts();
  const { home, api } = await boot({ tracker: async () => fake.ports.tracker });
  await createOperation(
    home,
    operation({
      id: "lin",
      tracker: "linear",
      contacts: [
        { ticket: "CHR-1", title: null, zone: "ops", kind: "implement", blockedBy: [], conflictOf: null, lane: null },
      ],
    }),
  );
  // lab (tracker none) never reaches the port.
  expect(await (await api("/api/tracker/search?op=lab&q=au")).json()).toEqual({ tracker: "none", hits: [] });
  expect(fake.calls).toHaveLength(0);
  // Unknown op / unknown project.
  expect((await api("/api/tracker/search?op=nope&q=au")).status).toBe(404);
  expect((await api("/api/tracker/search?project=nope&q=au")).status).toBe(404);
  // Short queries skip the CLI entirely.
  expect(await (await api("/api/tracker/search?op=lin&q=a")).json()).toEqual({ tracker: "linear", hits: [] });
  expect(fake.calls).toHaveLength(0);
  // A taken ticket is flagged; others pass through.
  fake.world.searchHits = [
    { ticket: "CHR-1", title: "Office today", state: "Backlog", url: null },
    { ticket: "CHR-2", title: "Audit export", state: "Todo", url: null },
  ];
  expect(await (await api("/api/tracker/search?op=lin&q=au")).json()).toEqual({
    tracker: "linear",
    hits: [
      { ticket: "CHR-1", title: "Office today", state: "Backlog", url: null, taken: true },
      { ticket: "CHR-2", title: "Audit export", state: "Todo", url: null },
    ],
  });
  expect(fake.calls.at(-1)).toMatchObject({ port: "tracker", method: "search" });
  // Tracker down is an error in the body, still a 200.
  fake.world.searchHits = null;
  const down = await (await api("/api/tracker/search?op=lin&q=au")).json();
  expect(down.tracker).toBe("linear");
  expect(down.error).toBe("tracker answered nothing");
});

test("tracker search resolves the project's tracker when no operation exists yet", async () => {
  const fake = fakePorts();
  const { home, api } = await boot({ tracker: async () => fake.ports.tracker });
  await createProject(home, {
    v: 1,
    id: "backyard",
    name: "Backyard",
    repo: "/tmp/backyard",
    base: "main",
    integration: "/tmp/backyard",
    pause: true,
    ignoreChecks: false,
    tracker: "linear",
    fleet: "none",
    frontend: "none",
    delivery: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  fake.world.searchHits = [{ ticket: "CHR-9", title: "Kiosk check-in", state: "Todo", url: null }];
  const body = await (await api("/api/tracker/search?project=backyard&q=ki")).json();
  expect(body).toEqual({ tracker: "linear", hits: [{ ticket: "CHR-9", title: "Kiosk check-in", state: "Todo", url: null }] });
  expect(fake.calls.at(-1)?.args).toMatchObject({ query: "ki", cwd: "/tmp/backyard" });
});
test("PUT /api/settings accepts null values for nullable settings", async () => {
  const { api } = await boot();
  const setModel = await api("/api/settings", {
    method: "PUT",
    body: { key: "ai.model", value: "openai/gpt-4o" },
  });
  expect(setModel.status).toBe(200);
  const setJson = (await setModel.json()) as { settings: { ai: { model: string | null } } };
  expect(setJson.settings.ai.model).toBe("openai/gpt-4o");

  const clearModel = await api("/api/settings", {
    method: "PUT",
    body: { key: "ai.model", value: null },
  });
  expect(clearModel.status).toBe(200);
  const clearJson = (await clearModel.json()) as { settings: { ai: { model: string | null } } };
  expect(clearJson.settings.ai.model).toBeNull();
  const badValue = await api("/api/settings", {
    method: "PUT",
    body: { key: "ai.model", value: 123 },
  });
  expect(badValue.status).toBe(400);
});

test("POST /api/drafts validates model argument", async () => {
  const { api } = await boot();

  const badModel = await api("/api/drafts", {
    method: "POST",
    body: { text: "draft text", repo: "/tmp/lab", model: 999 },
  });
  expect(badModel.status).toBe(400);

});

test("POST /api/actions rejects malformed args.model", async () => {
  const { api } = await boot({
    action: async () => {},
  });
  const badAction = await api("/api/actions", {
    method: "POST",
    body: { op: "lab", contact: "a", action: "launch", args: { model: 42 } },
  });
  expect(badAction.status).toBe(400);
});

test("Intel evaluates selected evidence without loading other histories or changing runtime state", async () => {
  const now = Date.parse("2026-01-01T00:01:00Z");
  const { home, api, base } = await boot({ now: () => now, refresh: async () => { throw new Error("Intel must not refresh missions"); } });
  await createOperation(home, operation({ id: "other", name: "Other" }));
  writeFileSync(join(operationDir(home, "other"), "events.jsonl"), "malformed interior history\n");
  const before = readFileSync(join(operationDir(home, "lab"), "events.jsonl"), "utf8");
  const sources = await (await api("/api/intel/sources")).json() as { operations: Array<{ id: string }> };
  expect(sources.operations.map(row => row.id).sort()).toEqual(["lab", "other"]);
  const snapshot = await (await api("/api/intel?op=lab")).json() as { closedAt: string | null; evaluation: { queued: { n: number; maxMs: number }; quality: unknown; asOf: number } };
  expect(snapshot.closedAt).toBeNull();
  expect(snapshot.evaluation.queued).toMatchObject({ n: 2, maxMs: 60_000 });
  expect(snapshot.evaluation.quality).toBeNull();
  expect(snapshot.evaluation.asOf).toBe(now);
  expect(readFileSync(join(operationDir(home, "lab"), "events.jsonl"), "utf8")).toBe(before);
  const projection = await (await api("/api/projection?op=lab")).json() as Record<string, unknown>;
  expect(projection).not.toHaveProperty("evaluation");
  expect((await fetch(`${base}/api/intel?op=lab`)).status).toBe(401);
  expect((await fetch(`${base}/api/intel/sources`)).status).toBe(401);
  for (const query of ["", "?op=", "?op=lab&archive=x", "?op=lab&op=other", "?archive=x&archive=y"])
    expect((await api(`/api/intel${query}`)).status).toBe(400);
  expect((await api("/api/intel?op=missing")).status).toBe(404);
  expect((await api("/api/intel?archive=..")).status).toBe(404);
});

test("Intel archives keep frozen evidence without reading histories and leave legacy evaluation unknown", async () => {
  let clock = Date.parse("2026-01-04T00:00:00Z");
  const { home, api } = await boot({ now: () => clock });
  const fake = fakePorts();
  await endOperation({ home, now: () => new Date(clock), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, run: noRun }, "lab", "abandoned");
  const sources = await (await api("/api/intel/sources")).json() as { archives: Array<{ key: string }> };
  const key = sources.archives[0].key;
  const first = await (await api(`/api/intel?archive=${key}`)).json() as { evaluation: { asOf: number }; closedAt: string };
  expect(first.evaluation.asOf).toBe(clock);
  expect(first.closedAt).toBe(new Date(clock).toISOString());
  writeFileSync(join(archiveDir(home), key, "events.jsonl"), "broken historical payload\n");
  clock += 86_400_000;
  expect(await (await api(`/api/intel?archive=${key}`)).json()).toEqual(first);
  expect((await api("/api/intel/sources")).status).toBe(200);
  const file = join(archiveDir(home), key, "report.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  delete stored.evaluation;
  writeFileSync(file, JSON.stringify(stored));
  const legacy = await (await api(`/api/intel?archive=${key}`)).json() as { evaluation: unknown };
  expect(legacy.evaluation).toBeNull();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(stored);
});
