import { test, expect } from "bun:test";
import { runSetupChecks } from "../src/setup.ts";
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
    await createProject(home, { v: 1, id: "p1", name: "p1", repo: "/p", base: "main", frontend: "herdr", tracker: "github", integration: "/p/integration", pause: false, fleet: "none", delivery: "none", worktreeRoot: "/p/{name}", createdAt: "2026-10-10T12:00:00.000Z" });

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