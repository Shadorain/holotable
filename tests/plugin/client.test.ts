import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureService, type ServiceHealth } from "../../src/plugin/client.ts";
import { UNIT_NAME } from "../../src/service.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-client-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const running = (url = "http://127.0.0.1:4848/#tok"): ServiceHealth => ({ running: true, url, urls: [url], pid: 123 });
const stopped = (): ServiceHealth => ({ running: false, url: null, pid: null });
const DEFAULT_HOME = join(homedir(), ".omp", "agent", "holotable");

describe("ensureService", () => {
  test("already running: no start path runs", async () => {
    const health = running();
    const result = await ensureService({
      home: tempDir(),
      checkHealth: async () => health,
      spawnDetached: () => {
        throw new Error("must not spawn");
      },
    });
    expect(result).toBe(health);
  });

  test("default home on linux with systemd installs+enables the unit when missing", async () => {
    const configDir = tempDir();
    let checks = 0;
    const installed: boolean[] = [];
    const result = await ensureService({
      home: DEFAULT_HOME,
      platform: "linux",
      hasSystemdUser: async () => true,
      checkHealth: async () => (++checks === 1 ? stopped() : running()),
      installService: async () => {
        installed.push(true);
        return { unitPath: join(configDir, "systemd", "user", UNIT_NAME), warnings: [] };
      },
      configDir,
      timeoutMs: 2000,
      pollIntervalMs: 10,
      spawnDetached: () => {
        throw new Error("must not spawn detached for the default home");
      },
    });
    expect(result.running).toBe(true);
    expect(installed).toEqual([true]);
  });

  test("default home with an existing unit starts it instead of installing", async () => {
    const configDir = tempDir();
    const unitPath = join(configDir, "systemd", "user", UNIT_NAME);
    mkdirSync(join(configDir, "systemd", "user"), { recursive: true });
    writeFileSync(unitPath, "[Unit]\n");
    let checks = 0;
    let started = 0;
    const result = await ensureService({
      home: DEFAULT_HOME,
      platform: "linux",
      hasSystemdUser: async () => true,
      checkHealth: async () => (++checks === 1 ? stopped() : running()),
      installService: async () => {
        throw new Error("unit exists: installService must not run");
      },
      startSystemdUnit: async () => {
        started += 1;
      },
      configDir,
      timeoutMs: 2000,
      pollIntervalMs: 10,
    });
    expect(result.running).toBe(true);
    expect(started).toBe(1);
  });

  test("a non-default home uses the detached spawn even when systemd is available", async () => {
    const home = tempDir();
    let checks = 0;
    const spawns: Array<{ cmd: string; args: string[]; logPath: string; home: string | undefined }> = [];
    const result = await ensureService({
      home,
      platform: "linux",
      hasSystemdUser: async () => true,
      checkHealth: async () => (++checks === 1 ? stopped() : running()),
      bunPath: "/bin/bun",
      scriptPath: "/repo/bin/holotable.ts",
      spawnDetached: (cmd, args, logPath, env) => {
        spawns.push({ cmd, args, logPath, home: env.OMP_HOLOTABLE_HOME });
      },
      timeoutMs: 2000,
      pollIntervalMs: 10,
    });
    expect(result.running).toBe(true);
    expect(spawns).toEqual([
      { cmd: "/bin/bun", args: ["/repo/bin/holotable.ts", "serve"], logPath: join(home, "board.log"), home },
    ]);
  });

  test("non-linux default home falls back to the detached spawn", async () => {
    const home = tempDir();
    let checks = 0;
    let spawned = 0;
    await ensureService({
      home,
      platform: "darwin",
      checkHealth: async () => (++checks === 1 ? stopped() : running()),
      spawnDetached: () => {
        spawned += 1;
      },
      timeoutMs: 2000,
      pollIntervalMs: 10,
    });
    expect(spawned).toBe(1);
  });

  test("times out with a helpful message when the board never answers", async () => {
    const home = tempDir();
    let spawned = 0;
    await expect(
      ensureService({
        home,
        platform: "darwin",
        checkHealth: async () => stopped(),
        spawnDetached: () => {
          spawned += 1;
        },
        timeoutMs: 60,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("failed to start");
    expect(spawned).toBe(1);
  });
});
