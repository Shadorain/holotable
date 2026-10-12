import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board, StartBoardOptions } from "../src/service.ts";
import { installService, ServiceError, startBoard, uninstallService } from "../src/service.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { writeSettings } from "../src/store/settings.ts";
import { boardIsLocked, readBoardInfo, readToken } from "../src/store/board.ts";
import { createOperation } from "../src/store/operations.ts";
import { serviceHealth, stopService } from "../src/plugin/client.ts";
import { fakePorts, noRun, operation } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function boot(over: Partial<StartBoardOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), "holotable-svc-"));
  await createOperation(home, operation());
  const settings = { ...DEFAULT_SETTINGS, access: "local" as const, port: 0, pollMs: 60_000, sampleMs: 60_000 };
  const fake = fakePorts();
  const board = await startBoard({
    home,
    settings,
    run: noRun,
    portsFor: () => fake.ports,
    ...over,
  });
  cleanup.push(async () => {
    await board.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, board, fake };
}

function api(url: string, path: string) {
  const base = new URL(url).origin;
  const token = new URL(url).hash.slice(1);
  return fetch(`${base}${path}`, { headers: { "x-holotable-token": token } });
}

test("serve: operations endpoint answers", async () => {
  const { home, board } = await boot();
  const res = await api(board.url, "/api/operations");
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{ id: string }>;
  expect(rows.map((row) => row.id)).toEqual(["lab"]);
});

test("a second startBoard refuses with the running owner", async () => {
  const { home, board } = await boot();
  const error = await startBoard({ home, settings: DEFAULT_SETTINGS }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe("locked");
  expect((await api((error as ServiceError).owner!.url, "/api/operations")).status).toBe(200);
});

test("the token persists across restarts so the URL stays valid", async () => {
  const { home, board } = await boot();
  const firstToken = new URL(board.url).hash.slice(1);
  expect(await readToken(home)).toBe(firstToken);
  await board.close();
  const { board: again } = await boot({ home });
  expect(new URL(again.url).hash.slice(1)).toBe(firstToken);
});

test("close removes board.json and frees the lock", async () => {
  const { home, board } = await boot();
  await board.close();
  expect(await readBoardInfo(home)).toBeNull();
  // The lock is free: another board can take it.
  const { board: next } = await boot({ home });
  expect(next.url).toContain("http://");
});

test("copied discovery cannot control another home; symlink aliases still reach their owner", async () => {
  const { home, board } = await boot();
  const clone = mkdtempSync(join(tmpdir(), "holotable-copied-"));
  const alias = `${home}-alias`;
  cleanup.push(() => rmSync(clone, { recursive: true, force: true }));
  cleanup.push(() => rmSync(alias, { force: true }));
  copyFileSync(join(home, "board.json"), join(clone, "board.json"));
  copyFileSync(join(home, "token"), join(clone, "token"));
  symlinkSync(home, alias, "dir");
  expect((await serviceHealth(clone)).running).toBe(false);
  expect((await stopService(clone)).running).toBe(false);
  expect((await serviceHealth(home)).running).toBe(true);
  expect((await serviceHealth(alias)).running).toBe(true);
  expect((await api(board.url, "/api/operations")).status).toBe(200);
});

test("shutdown finishes an in-flight response before releasing ownership", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settings = { ...DEFAULT_SETTINGS, access: "local" as const, port: 0, pollMs: 60_000, sampleMs: 60_000 };
  let block = false;
  const { home, board } = await boot({ settings: async () => {
    if (block) {
      entered.resolve();
      await release.promise;
    }
    return settings;
  } });
  block = true;
  const response = api(board.url, "/api/settings").then(async (res) => {
    await res.arrayBuffer();
    return res.status;
  }, () => 0);
  await entered.promise;
  const closing = board.close();
  try {
    expect(await boardIsLocked(home)).toBe(true);
  } finally {
    release.resolve();
    await closing;
  }
  expect(await response).toBe(200);
  expect(await boardIsLocked(home)).toBe(false);
  expect(await readBoardInfo(home)).toBeNull();
});

test("shutdown requires authentication and the current instance identity", async () => {
  const { home, board } = await boot();
  const base = new URL(board.url).origin;
  const identity = await (await api(board.url, "/api/service")).json() as { pid: number; instance: string };
  const post = (token: string, instance: string) => fetch(`${base}/api/service/stop`, {
    method: "POST", headers: { origin: base, "x-holotable-token": token, "content-type": "application/json" },
    body: JSON.stringify({ pid: identity.pid, instance }),
  });
  expect((await post("wrong", identity.instance)).status).toBe(401);
  const token = new URL(board.url).hash.slice(1);
  expect((await post(token, "stale-instance")).status).toBe(409);
  expect((await serviceHealth(home)).running).toBe(true);
  await stopService(home);
  expect((await serviceHealth(home)).running).toBe(false);
  expect(await readToken(home)).toBe(token);
});

test("stopping one home leaves another board in the same process running", async () => {
  const first = await boot();
  const second = await boot();
  await stopService(first.home);
  expect(await readBoardInfo(first.home)).toBeNull();
  expect((await serviceHealth(second.home)).running).toBe(true);
  expect((await (await api(second.board.url, "/api/operations")).json() as Array<{ id: string }>).map((op) => op.id)).toEqual(["lab"]);
});

test("a startup configuration error releases ownership for a corrected restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "holotable-svc-error-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ theme: "invalid" }));
  await expect(startBoard({ home, run: noRun })).rejects.toThrow("theme");
  expect(await boardIsLocked(home)).toBe(false);
  await writeSettings(home, { ...DEFAULT_SETTINGS, access: "local", port: 0 });
  const board = await startBoard({ home, run: noRun, portsFor: () => fakePorts().ports });
  cleanup.unshift(() => board.close());
  expect((await serviceHealth(home)).running).toBe(true);
});

test("settings are re-read every pass", async () => {
  const home = mkdtempSync(join(tmpdir(), "holotable-svc-"));
  await createOperation(home, operation());
  let reads = 0;
  const fake = fakePorts();
  const board: Board = await startBoard({
    home,
    settings: async () => {
      reads += 1;
      return { ...DEFAULT_SETTINGS, pollMs: 40, sampleMs: 60_000 };
    },
    run: noRun,
    portsFor: () => fake.ports,
  });
  cleanup.push(async () => {
    await board.close();
    rmSync(home, { recursive: true, force: true });
  });
  const before = reads;
  // The poll loop is a real setTimeout chain: counting invocations needs wall clock.
  await new Promise((resolve) => setTimeout(resolve, 130));
  expect(reads).toBeGreaterThan(before + 1);
});

test("installService writes the unit under the config dir and reloads/enables", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "holotable-xdg-"));
  cleanup.push(() => rmSync(configDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const result = await installService(
    {
      bunPath: "/bin/bun",
      scriptPath: "/repo/bin/holotable.ts",
      configDir,
      env: { path: "/a:/b", home: "/tmp/ht-home" },
      systemctl: async (args) => {
        calls.push(args);
        return { code: 0, stderr: "" };
      },
    },
    true,
  );
  expect(result.unitPath).toBe(join(configDir, "systemd", "user", "holotable.service"));
  const unit = readFileSync(result.unitPath, "utf8");
  expect(unit).toContain('ExecStart="/bin/bun" "/repo/bin/holotable.ts" serve');
  expect(unit).toContain("Environment=OMP_HOLOTABLE_HOME=/tmp/ht-home");
  expect(calls).toEqual([["--user", "daemon-reload"], ["--user", "enable", "--now", "holotable.service"]]);
});

test("installService without --now only reloads; a failing systemctl is a warning not a failure", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "holotable-xdg-"));
  cleanup.push(() => rmSync(configDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const result = await installService(
    {
      bunPath: "/bin/bun",
      scriptPath: "/repo/bin/holotable.ts",
      configDir,
      systemctl: async (args) => {
        calls.push(args);
        return { code: 1, stderr: "no user bus" };
      },
    },
    false,
  );
  expect(calls).toEqual([["--user", "daemon-reload"]]);
  expect(result.warnings.length).toBe(1);
  expect(result.warnings[0]).toContain("no user bus");
});

test("uninstallService disables, removes the unit and reloads", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "holotable-xdg-"));
  cleanup.push(() => rmSync(configDir, { recursive: true, force: true }));
  writeFileSync(join(configDir, "holotable.service"), "x");
  const calls: string[][] = [];
  await uninstallService({
    bunPath: "/bin/bun",
    scriptPath: "/repo/bin/holotable.ts",
    configDir,
    systemctl: async (args) => {
      calls.push(args);
      return { code: 0, stderr: "" };
    },
  });
  expect(calls).toEqual([["--user", "disable", "--now", "holotable.service"], ["--user", "daemon-reload"]]);
  expect(() => readFileSync(join(configDir, "systemd", "user", "holotable.service"))).toThrow();
});
