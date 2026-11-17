import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runSetupChecks } from "../src/setup.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { tempDir, removeAll } from "./helpers.ts";
import { writeSettings } from "../src/store/settings.ts";
import { createProject } from "../src/store/projects.ts";

test("setup checks: route shape, failures become ok:false with fix, only in-use tools checked", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup", bucket);
  try {
    await writeSettings(home, { defaults: { tracker: "none", frontend: "none", fleet: "none", delivery: "none" } } as any);
    
    // Default config has frontendsInUse = ["none"]
    let checks = await runSetupChecks(home, async (cmd, args) => {
      if (cmd === "omp" && args[0] === "--version") return { code: 0, stdout: "omp v1", stderr: "" };
      if (cmd === "omp" && args[0] === "plugin") return { code: 1, stdout: "", stderr: "no plugin" };
      return { code: 0, stdout: "", stderr: "" };
    });

    expect(checks.counts.projects).toBe(0);
    expect(checks.counts.operations).toBe(0);
    
    // omp-mission fails, so it should be ok: false with fix
    const mission = checks.checks.find(c => c.id === "omp-mission");
    expect(mission).toBeDefined();

    // frontend-none check is present because ONLY "none" is in use
    const noFrontend = checks.checks.find(c => c.id === "frontend-none");
    expect(noFrontend?.ok).toBe(false);
    expect(noFrontend?.fix).toBe("Configure a frontend in global settings or operations");

    // herdr and github should NOT be checked since they are not in use
    expect(checks.checks.some(c => c.id === "herdr")).toBe(false);
    expect(checks.checks.some(c => c.id === "github")).toBe(false);

    // Now let's add a project using herdr and github
    await createProject(home, { v: 1, id: "p1", name: "p1", repo: "/p", base: "main", frontend: "herdr", tracker: "github", integration: "/p/integration", pause: false, ignoreChecks: false, fleet: "none", delivery: "none", worktreeRoot: "/p/{name}", createdAt: "2026-10-10T12:00:00.000Z" });

    checks = await runSetupChecks(home, async (cmd, args) => {
      if (cmd === "herdr") return { code: 127, stdout: "", stderr: "command not found" }; // Failing command
      if (cmd === "gh") return { code: 0, stdout: "auth ok", stderr: "" }; // passing
      return { code: 0, stdout: "{}", stderr: "" };
    });

    // herdr should be ok:false with fix, github ok:true
    const herdr = checks.checks.find(c => c.id === "herdr");
    expect(herdr?.ok).toBe(false);
    expect(herdr?.fix).toBe("Ensure herdr is in PATH");

    const github = checks.checks.find(c => c.id === "github");
    expect(github?.ok).toBe(true);

    // frontend-none should be gone since "herdr" is also in use
    expect(checks.checks.some(c => c.id === "frontend-none")).toBe(false);

  } finally {
    removeAll(bucket);
  }
});

test("Orca setup check requires startup command support, not just a version", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-orca", bucket);
  try {
    await writeSettings(home, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, frontend: "orca" } });
    const report = await runSetupChecks(home, async (command, args) =>
      command === "orca" && args[0] === "--version"
        ? { code: 0, stdout: "Orca 1.0", stderr: "" }
        : command === "orca" && args[0] === "worktree"
          ? { code: 0, stdout: "Usage: orca worktree create", stderr: "" }
          : { code: 0, stdout: "{}", stderr: "" },
    );
    const check = report.checks.find((row) => row.id === "orca");
    expect(check?.ok).toBe(false);
    expect(check?.fix).toContain("worktree create --command");
  } finally {
    removeAll(bucket);
  }
});

test("setup refuses outdated, prerelease and unidentifiable OMP binaries", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-version", bucket);
  try {
    await writeSettings(home, DEFAULT_SETTINGS);
    for (const [version, supported] of [
      ["18.21.9", false], ["omp v18.22.0", true], ["18.23.0+build1", true],
      ["19.0.0", true], ["18.22.0-beta.1", false], ["omp v1", false], ["", false],
    ] as const) {
      const report = await runSetupChecks(home, async (_cmd, args) => ({
        code: 0, stdout: args[0] === "--version" ? version : '{"npm":[]}', stderr: "",
      }));
      expect(report.checks.find((row) => row.id === "omp")?.ok).toBe(supported);
    }
  } finally {
    removeAll(bucket);
  }
});

test("setup distinguishes active, disabled and duplicate mission copies in an isolated agent directory", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-plugins", bucket);
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await writeSettings(home, DEFAULT_SETTINGS);
    const scenarios = [
      { enabled: true, linked: false, ok: true },
      { enabled: false, linked: false, ok: false },
      { enabled: true, linked: true, ok: false },
      { enabled: false, linked: true, ok: true },
      { linked: true, ok: true },
      { linked: false, ok: false },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const agent = join(home, `agent-${index}`);
      process.env.PI_CODING_AGENT_DIR = agent;
      if (scenario.linked) await mkdir(join(agent, "extensions", "omp-mission"), { recursive: true });
      const report = await runSetupChecks(home, async (_cmd, args) => ({
        code: 0,
        stdout: args[0] === "--version" ? "18.22.0" : JSON.stringify({
          npm: scenario.enabled === undefined ? [] : [{ name: "omp-mission", enabled: scenario.enabled }],
        }),
        stderr: "",
      }));
      expect(report.checks.find((row) => row.id === "omp-mission")?.ok).toBe(scenario.ok);
    }
    const unknown = await runSetupChecks(home, async () => ({ code: 0, stdout: "invalid-json", stderr: "" }));
    expect(unknown.checks.find((row) => row.id === "omp-mission")?.ok).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    removeAll(bucket);
  }
});