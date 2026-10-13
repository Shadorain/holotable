import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type BoardServer } from "../src/server.ts";
import { createBoardService } from "../src/board.ts";
import { readProject } from "../src/store/projects.ts";
import { writeSettings } from "../src/store/settings.ts";
import { recordRecentRepo } from "../src/store/recent-repos.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import type { CommandResult, Run } from "../src/ports.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

interface Call {
  command: string;
  args: string[];
  cwd: string;
}
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });
const fail = (code = 1, stderr = ""): CommandResult => ({ stdout: "", stderr, code });

function fakeRun(handler: (call: Call) => CommandResult | null): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd) => {
    const call = { command, args, cwd };
    calls.push(call);
    return handler(call) ?? { stdout: "", stderr: "not found", code: 127 };
  };
  return { run, calls };
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "holotable-repos-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function boot(run: Run, home = tempHome(), settings: { access?: "local" | "tailscale" | "network"; port: number } = { access: "local", port: 0 }) {
  const server: BoardServer = await startServer({ service: createBoardService(home, { run }), settings, token: "tok" });
  cleanup.push(() => server.close());
  const url = new URL(server.url);
  const base = `${url.protocol}//${url.host}`;
  const api = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-holotable-token": "tok",
        ...(init.body !== undefined ? { origin: base, "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  return { home, server, base, api };
}

describe("listenWithFallback", () => {
  test("a taken desired port falls to the next port and the URL shows it", async () => {
    // Block whatever free port the OS hands out, never a real one (the board itself may own 4848).
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => blocker.once("error", reject).listen(0, "0.0.0.0", resolve));
    cleanup.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    if (address === null || typeof address === "string") throw new Error("blocker has no TCP address");
    const taken = address.port;
    const { server } = await boot(fakeRun(() => null).run, tempHome(), { access: "local", port: taken });
    const port = Number(new URL(server.url).port);
    expect(port).toBeGreaterThan(taken);
    expect(port).toBeLessThanOrEqual(taken + 10);
    expect(server.urls.every((u) => u.includes(`:${port}/`))).toBe(true);
  });
});

describe("rebind", () => {
  test("rebinding to a new port republishes the URL list", async () => {
    const { server, home } = await boot(fakeRun(() => null).run);
    const first = server.urls;
    const rebound = await server.rebind({ access: "local", port: 0 });
    expect(rebound.urls.every((u) => !u.includes(`:${new URL(first[0]!).port}/`))).toBe(true);
    expect(server.url).toBe(rebound.url);
    expect(server.urls).toEqual(rebound.urls);
    expect(new URL(rebound.url).port).not.toBe(new URL(first[0]!).port);
    void home;
  });

  test("rebinding local -> network keeps serving and adds urls from the machine", async () => {
    const { server, api } = await boot(fakeRun(() => null).run);
    await server.rebind({ access: "network", port: Number(new URL(server.url).port) });
    expect(server.urls.length).toBeGreaterThanOrEqual(1);
    const res = await api("/api/operations");
    expect(res.status).toBe(200);
  });
});

describe("repos and detect routes", () => {
  const gitRepo = (repo: string, branch = "main", remote = "https://github.com/acme/demo.git", head = "origin/main") => (call: Call) => {
    const { command, args, cwd } = call;
    if (command === "git" && args[0] === "rev-parse") return ok(`${repo}\n`);
    if (command === "orca") return fail(127);
    if (command === "git" && args[0] === "symbolic-ref") return ok(`${head}\n`);
    if (command === "git" && args[0] === "branch") return ok(`${branch}\n`);
    if (command === "git" && args[0] === "remote") return remote ? ok(`${remote}\n`) : fail(2);
    if (command === "gh") return ok();
    if (command === "lin") return ok("{}");
    if (command === "herdr") return fail(127);
    void cwd;
    return null;
  };

  test("POST /api/projects/detect detects fields and reasons", async () => {
    const repo = tempHome();
    const { run } = fakeRun(gitRepo(repo));
    const { api } = await boot(run);
    const res = await api("/api/projects/detect", { method: "POST", body: { repo } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fields: Record<string, unknown>; reasons: Record<string, string> };
    expect(body.fields.name).toBe(repo.split("/").pop());
    expect(body.fields.base).toBe("main");
    expect(body.fields.integration).toBe(repo);
    expect(body.fields.tracker).toBe("linear");
    expect(body.fields.delivery).toBe("github-pr");
    expect(body.fields.fleet).toBe("omp-mission");
    expect(body.fields.pause).toBe(false);
    expect(body.reasons.pause).toBe("Settings mission mode: auto");
    expect(Object.keys(body.reasons).length).toBeGreaterThan(3);
  });

  test("POST /api/projects/detect on a non-git path is a clear 400", async () => {
    const { run } = fakeRun(() => fail(128, "fatal: not a git repository"));
    const { api } = await boot(run);
    const res = await api("/api/projects/detect", { method: "POST", body: { repo: "/tmp/definitely-not-git" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not inside a git work tree");
  });

  test("POST /api/projects with only repo runs detection and creates the project", async () => {
    const repo = tempHome();
    const { run, calls } = fakeRun(gitRepo(repo, "dev", "", "origin/dev"));
    const { home, api } = await boot(run);
    const res = await api("/api/projects", { method: "POST", body: { repo } });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    const project = await readProject(home, created.id);
    expect(project.repo).toBe(repo);
    expect(project.base).toBe("dev");
    expect(project.integration).toBe(repo);
    expect(project.tracker).toBe("linear");
    expect(project.delivery).toBe("local-merge");
    expect(project.pause).toBe(false);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "rev-parse")).toBe(true);
    expect(calls.some((c) => c.command === "lin")).toBe(true);
  });

  test("saved defaults.pause true is inherited unless the body sets pause", async () => {
    const home = tempHome();
    const pausedRepo = tempHome();
    const explicitRepo = tempHome();
    await writeSettings(home, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, pause: true } });
    const { run } = fakeRun((call) => {
      const { command, args, cwd } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${cwd}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return fail(2);
      if (command === "gh" || command === "lin" || command === "herdr") return fail(127);
      return null;
    });
    const { api } = await boot(run, home);
    const detected = await api("/api/projects/detect", { method: "POST", body: { repo: pausedRepo } });
    expect(detected.status).toBe(200);
    const detectedBody = (await detected.json()) as { fields: { pause: boolean } };
    expect(detectedBody.fields.pause).toBe(true);
    const created = await api("/api/projects", { method: "POST", body: { repo: pausedRepo } });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { id: string };
    expect((await readProject(home, createdBody.id)).pause).toBe(true);
    const explicit = await api("/api/projects", { method: "POST", body: { repo: explicitRepo, pause: false } });
    expect(explicit.status).toBe(200);
    const explicitBody = (await explicit.json()) as { id: string };
    expect((await readProject(home, explicitBody.id)).pause).toBe(false);
    expect((await readProject(home, createdBody.id)).pause).toBe(true);
  });

  test("GET /api/repos merges project, orca and session rows deduped by realpath", async () => {
    const home = tempHome();
    const repoA = join(home, "a");
    const repoB = join(home, "b");
    mkdirSync(repoA);
    const { run } = fakeRun((call) => {
      const { command, args, cwd } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${cwd}\n`);
      if (command === "orca" && args[0] === "repo" && args[1] === "list")
        return ok(JSON.stringify({ repos: [{ path: repoB, displayName: "Orca B", worktreeBaseRef: "origin/dev" }] }));
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo.git\n");
      if (command === "gh") return ok();
      if (command === "lin") return ok("{}");
      if (command === "herdr") return fail(127);
      return null;
    });
    const { api } = await boot(run, home);
    // One project on repo-a, one recent session repo; repo-b also comes back from Orca.
    const res = await api("/api/projects", { method: "POST", body: { repo: repoA } });
    expect(res.status).toBe(200);
    await recordRecentRepo(home, repoB);
    await recordRecentRepo(home, repoA);
    const rows = (await (await api("/api/repos")).json()) as Array<{ path: string; name: string; source: string }>;
    const byRealpath = new Set(rows.map((r) => r.path));
    expect(byRealpath.size).toBe(rows.length);
    expect(rows.find((r) => r.path === repoA)?.source).toBe("project");
    expect(rows.find((r) => r.path === repoB)?.source).toBe("orca");
    expect(rows.find((r) => r.path === repoB)?.name).toBe("Orca B");
  });

  test("GET /api/repos answers with no projects and a dead orca CLI", async () => {
    const { run } = fakeRun(() => fail(127));
    const { api } = await boot(run);
    const res = await api("/api/repos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
