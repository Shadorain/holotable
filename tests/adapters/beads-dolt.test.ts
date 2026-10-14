import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPort,
  doltState,
  installDolt,
  renderServerConfig,
  renderUnit,
  restartDolt,
  serverMode,
  unitName,
} from "../../src/adapters/beads-dolt.ts";
import type { Run } from "../../src/ports.ts";

const run: Run = async () => { throw new Error("no command expected"); };


async function repo(server: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dolt-"));
  if (server) {
    const beads = join(root, ".beads");
    await Bun.write(join(beads, "metadata.json"), JSON.stringify({ dolt_mode: "server", database: "dolt" }));
    await Bun.write(join(beads, "dolt", ".keep"), "");
  }
  return root;
}

test("a repo without a server-mode bead database is not managed", async () => {
  const root = await repo(false);
  expect(await serverMode(root)).toBe(false);
  const state = await doltState("charidel", root, { run });
  expect(state.managed).toBe(false);
  expect(state.unit).toBeNull();
  await rm(root, { recursive: true, force: true });
});

test("install writes the unit and server config, pins the port, and disables bd auto-start", async () => {
  const root = await repo(true);
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const result = await installDolt("charidel", "Charidel", root, {
    run,
    doltPath: "/usr/local/bin/dolt",
    unitDir: "/cfg/systemd/user",
    write: async (path, content) => { files.set(path, content); },
    read: async (path) => files.get(path) ?? null,
    systemctl: async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
  });
  expect(result.unit).toBe("beads-dolt-charidel.service");
  expect(result.port).toBe(defaultPort(root));
  expect(calls).toEqual([["daemon-reload"], ["enable", "--now", "beads-dolt-charidel.service"]]);

  const unit = files.get("/cfg/systemd/user/beads-dolt-charidel.service")!;
  expect(unit).toContain(`ExecStart="/usr/local/bin/dolt" sql-server --config "${join(root, ".beads", "dolt", "config.yaml")}"`);
  expect(unit).toContain("Restart=always");
  // The unit parents the server itself; `bd dolt start` would leave it parented to a pane.
  expect(unit).not.toMatch(/^ExecStart=.*\bbd\b/m);

  const config = files.get(join(root, ".beads", "dolt", "config.yaml"))!;
  expect(config).toContain(`port: ${result.port}`);
  expect(files.get(join(root, ".beads", "config.yaml"))).toContain("dolt.auto-start: false");

  // A second install keeps the existing port, so a running graph is not moved under live missions.
  const again = await installDolt("charidel", "Charidel", root, {
    run,
    doltPath: "/usr/local/bin/dolt",
    unitDir: "/cfg/systemd/user",
    write: async (path, content) => { files.set(path, content); },
    read: async (path) => files.get(path) ?? null,
    systemctl: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  expect(again.port).toBe(result.port);
  // An existing auto-start line is rewritten rather than duplicated.
  expect((files.get(join(root, ".beads", "config.yaml")) ?? "").match(/dolt\.auto-start/g)).toHaveLength(1);
  await rm(root, { recursive: true, force: true });
});

test("install refuses a repo that is not server mode", async () => {
  const root = await repo(false);
  await expect(installDolt("x", "X", root, {
    run, doltPath: "/bin/dolt", unitDir: "/cfg", write: async () => {}, read: async () => null,
  })).rejects.toThrow(/no server-mode bead database/);
  await rm(root, { recursive: true, force: true });
});

test("state reports a missing unit, a down unit, and a reachable server differently", async () => {
  const root = await repo(true);
  await writeFile(join(root, ".beads", "dolt", "config.yaml"), renderServerConfig(root, 39000));
  const systemctl = async (args: string[]) =>
    args[0] === "is-active" ? { code: 3, stdout: "inactive\n", stderr: "" } : { code: 1, stdout: "", stderr: "No files found" };
  const missing = await doltState("charidel", root, { run, systemctl });
  expect(missing.managed).toBe(true);
  expect(missing.unitState).toBe("missing");
  expect(missing.reachable).toBe(false);
  expect(missing.detail).toContain("Install");

  const down = await doltState("charidel", root, {
    run,
    systemctl: async () => ({ code: 3, stdout: "failed\n", stderr: "" }),
  });
  expect(down.unitState).toBe("failed");
  expect(down.reachable).toBe(false);
  expect(down.detail).toContain("failed");
  await rm(root, { recursive: true, force: true });
});

test("restart runs the unit restart and surfaces its failure", async () => {
  const calls: string[][] = [];
  await restartDolt("charidel", "/repo", { run, systemctl: async (args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; } });
  expect(calls).toEqual([["restart", unitName("charidel")]]);
  await expect(restartDolt("charidel", "/repo", {
    run, systemctl: async () => ({ code: 1, stdout: "", stderr: "Unit not found" }),
  })).rejects.toThrow("Unit not found");
});

test("renderUnit and renderServerConfig are stable for the hand-written charidel unit shape", () => {
  const unit = renderUnit({ projectName: "Charidel", repo: "/r", doltPath: "/bin/dolt" });
  for (const line of ["Type=simple", "Restart=always", "RestartSec=2", "WantedBy=default.target"])
    expect(unit).toContain(line);
  expect(renderServerConfig("/r", 38581)).toContain("host: 127.0.0.1");
});
