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

test("setup checks every configured Linear workspace and reports each authenticated viewer", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-linear-workspaces", bucket);
  try {
    await writeSettings(home, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, tracker: "linear" } });
    for (const [id, name, repo] of [
      ["lyricin", "LyricIn", "/repos/lyricin"],
      ["charidel", "Charidel", "/repos/charidel"],
    ]) await createProject(home, {
      v: 1, id, name, repo, base: "main", frontend: "none", tracker: "linear",
      integration: repo, pause: false, ignoreChecks: false, fleet: "none", delivery: "none",
      worktreeRoot: `${repo}/{name}`, createdAt: "2026-10-10T12:00:00.000Z",
    });
    const calls: string[][] = [];
    const report = await runSetupChecks(home, async (command, args, cwd) => {
      calls.push([command, ...args, cwd]);
      if (command === "git") return {
        code: 0,
        stdout: cwd === "/repos/lyricin" ? "LyricIn\n" : "Charidel\n",
        stderr: "",
      };
      if (command === "lin") return {
        code: 0,
        stdout: JSON.stringify({ viewer: { email: args.at(-1) === "LyricIn" ? "shadorain7517@gmail.com" : "jordanf7517@gmail.com" } }),
        stderr: "",
      };
      return { code: 0, stdout: "{}", stderr: "" };
    });
    const linearCalls = calls.filter(([command]) => command === "lin");
    expect(linearCalls).toHaveLength(2);
    expect(linearCalls).toEqual(expect.arrayContaining([
      ["lin", "me", "--json", "--workspace", "LyricIn", expect.any(String)],
      ["lin", "me", "--json", "--workspace", "Charidel", expect.any(String)],
    ]));
    expect(report.checks.find(({ id }) => id === "linear:LyricIn")?.detail).toContain("shadorain7517@gmail.com");
    expect(report.checks.find(({ id }) => id === "linear:Charidel")?.detail).toContain("jordanf7517@gmail.com");
  } finally {
    removeAll(bucket);
  }
});

test("setup does not fall back to the default Linear account after selected workspace auth fails", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-linear-failure", bucket);
  try {
    await writeSettings(home, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, tracker: "linear" } });
    await createProject(home, {
      v: 1, id: "charidel", name: "Charidel", repo: "/repos/charidel", base: "main",
      frontend: "none", tracker: "linear", integration: "/repos/charidel", pause: false,
      ignoreChecks: false, fleet: "none", delivery: "none", worktreeRoot: "/repos/charidel/{name}",
      createdAt: "2026-10-10T12:00:00.000Z",
    });
    const linArgs: string[][] = [];
    const report = await runSetupChecks(home, async (command, args) => {
      if (command === "git") return { code: 0, stdout: "Charidel\n", stderr: "" };
      if (command === "lin") {
        linArgs.push(args);
        return args.includes("Charidel")
          ? { code: 1, stdout: "", stderr: "not authenticated" }
          : { code: 0, stdout: '{"email":"shadorain7517@gmail.com"}', stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    });
    expect(linArgs).toEqual([["me", "--json", "--workspace", "Charidel"]]);
    expect(report.checks.find(({ id }) => id === "linear:Charidel")?.ok).toBe(false);
  } finally {
    removeAll(bucket);
  }
});

test("setup checks the default Linear workspace with no project context", async () => {
  const bucket: string[] = [];
  const home = tempDir("setup-linear-default", bucket);
  try {
    await writeSettings(home, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, tracker: "linear" } });
    let linArgs: string[] | undefined;
    const report = await runSetupChecks(home, async (command, args) => {
      if (command === "lin") {
        linArgs = args;
        return { code: 0, stdout: '{"viewer":{"email":"default@example.com"}}', stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    });
    expect(linArgs).toEqual(["me", "--json"]);
    expect(report.checks.find(({ id }) => id === "linear")?.detail).toContain("default@example.com");
  } finally {
    removeAll(bucket);
  }
});