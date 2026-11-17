import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "./ports.ts";
import { messageOf } from "./core/errors.ts";
import { agentDir } from "./paths.ts";
import { listOperations, readOperation } from "./store/operations.ts";
import { listProjects } from "./store/projects.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { readSettings } from "./store/settings.ts";
import { checkOrcaStartupCommand } from "./adapters/orca-capabilities.ts";
import { readLinearWorkspace } from "./adapters/linear-account.ts";
import { withTimeout } from "./timeout.ts";
import { loadProjection } from "./snapshot.ts";
export interface SetupCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface SetupReport {
  checks: SetupCheck[];
  counts: {
    projects: number;
    operations: number;
    contacts: number;
    launched: number;
  };
}

const RUN_TIMEOUT = 5000;

async function runWithTimeout(
  run: Run,
  command: string,
  args: string[],
  cwd: string = process.cwd()
): Promise<{ code: number; stdout: string; stderr: string; detail?: string }> {
  // Run is a fire-and-forget port with no handle to kill; a timed-out child may
  // still settle the race later.
  try {
    return await withTimeout(run(command, args, cwd), RUN_TIMEOUT, "Timeout");
  } catch (error) {
    return { code: -1, stdout: "", stderr: "", detail: messageOf(error) };
  }
}

export async function runSetupChecks(home: string, run?: Run): Promise<SetupReport> {
  const checkPromises: Promise<SetupCheck>[] = [];

  // A corrupt store must surface as a failed check, not take the whole route
  // down with a 500.
  const operations = await listOperations(home).catch((error: unknown) => {
    checkPromises.push(Promise.resolve({
      id: "operations-store",
      label: "Operations Store",
      ok: false,
      detail: `Failed to list operations: ${messageOf(error)}`,
      fix: `Inspect the operation documents under ${join(home, "operations")} and fix or remove the invalid one`,
    }));
    return null;
  });

  const projects = await listProjects(home).catch((error: unknown) => {
    checkPromises.push(Promise.resolve({
      id: "projects-store",
      label: "Projects Store",
      ok: false,
      detail: `Failed to list projects: ${messageOf(error)}`,
      fix: `Inspect the project.json files under ${join(home, "projects")} and fix or remove the invalid one`,
    }));
    return null;
  });

  let contacts = 0;
  let launched = 0;

  const trackersInUse = new Set<string>();
  const frontendsInUse = new Set<string>();
  const deliveriesInUse = new Set<string>();
  const linearRepositories: string[] = [];
  const settings = await readSettings(home).catch(() => null);
  if (settings) {
    trackersInUse.add(settings.defaults.tracker);
    frontendsInUse.add(settings.defaults.frontend);
    deliveriesInUse.add(settings.defaults.delivery);
  }

  // listProjects already returns validated projects.
  for (const proj of projects ?? []) {
    trackersInUse.add(proj.tracker);
    frontendsInUse.add(proj.frontend);
    deliveriesInUse.add(proj.delivery);
    if (proj.tracker === "linear") linearRepositories.push(proj.repo);
  }

  // loadProjection reads the operation document internally; the resolved
  // fields and per-contact lane are exposed on the projection, so one read
  // covers both the tool sets and the counts.
  for (const row of operations ?? []) {
    try {
      const p = await loadProjection(home, row.id, settings ?? DEFAULT_SETTINGS, Date.now());
      trackersInUse.add(p.operation.tracker);
      frontendsInUse.add(p.operation.frontend);
      deliveriesInUse.add(p.operation.delivery);
      if (p.operation.tracker === "linear")
        linearRepositories.push((await readOperation(home, row.id)).repo);
      contacts += p.contacts.length;
      launched += p.contacts.filter((c) => c.lane !== null).length;
    } catch (error) {
      checkPromises.push(Promise.resolve({
        id: `operation-${row.id}`,
        label: `Operation ${row.id}`,
        ok: false,
        detail: `Failed to load operation "${row.id}": ${messageOf(error)}`,
        fix: `Fix or remove the invalid operation document in ${join(home, "operations", row.id)}`,
      }));
    }
  }

  const addCheck = (
    id: string,
    label: string,
    p: Promise<{ ok: boolean; detail: string; fix?: string }>
  ) => {
    checkPromises.push(
      p.then((res) => ({ id, label, ...res })).catch((err) => ({
        id,
        label,
        ok: false,
        detail: messageOf(err),
      }))
    );
  };

  if (run) {
    addCheck("omp", "OMP CLI", runWithTimeout(run, "omp", ["--version"]).then((res) => {
      const version = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?(?:\s|$)/i.exec(res.stdout.trim());
      if (res.code === 0 && version && (Number(version[1]) > 18 || (Number(version[1]) === 18 && Number(version[2]) >= 22)))
        return { ok: true, detail: res.stdout.trim() };
      return {
        ok: false,
        detail: res.code !== 0 ? (res.detail ?? res.stderr.trim()) || "omp not found"
          : version ? `${res.stdout.trim()} is older than the required OMP 18.22.0`
            : `Cannot determine the OMP version from ${JSON.stringify(res.stdout.trim())}`,
        fix: "Install OMP 18.22.0 or newer with native HTML forms and session lifecycle APIs",
      };
    }));

    addCheck("omp-mission", "OMP Mission Extension", (async () => {
      const [p, linked] = await Promise.all([
        runWithTimeout(run, "omp", ["plugin", "list", "--json"]),
        stat(join(agentDir(), "extensions", "omp-mission")).then(() => true).catch(() => false),
      ]);
      let installed = false;
      let enabled = false;
      let verified = false;
      if (p.code === 0) {
        try {
          const parsed = JSON.parse(p.stdout);
          verified = Array.isArray(parsed?.npm);
          const plugins: unknown[] = Array.isArray(parsed?.npm) ? parsed.npm : [];
          for (const plugin of plugins) {
            if (typeof plugin !== "object" || plugin === null || !("name" in plugin) || plugin.name !== "omp-mission") continue;
            installed = true;
            enabled ||= "enabled" in plugin && plugin.enabled === true;
          }
        } catch {}
      }
      if (!verified) return {
        ok: false,
        detail: "Cannot verify enabled omp-mission copies from OMP's plugin list",
        fix: "Run omp plugin list --json and repair its reported error before launching missions",
      };
      if (enabled && linked) return {
        ok: false,
        detail: "Both the npm plugin and linked omp-mission extension are enabled; duplicate copies can register conflicting tools and shortcuts",
        fix: "omp plugin disable omp-mission (keep the linked extension enabled), then start fresh OMP sessions",
      };
      if (linked) return { ok: true, detail: "Active linked extension; no enabled npm duplicate" };
      if (enabled) return { ok: true, detail: "Enabled npm plugin" };
      return {
        ok: false,
        detail: installed ? "The installed omp-mission plugin is disabled; launched sessions cannot open mission plans"
          : "No active omp-mission extension found; launched sessions cannot open mission plans",
        fix: installed ? "omp plugin enable omp-mission" : "omp plugin link <path to your omp-mission checkout>",
      };
    })());

    if (frontendsInUse.size === 1 && frontendsInUse.has("none")) {
      checkPromises.push(
        Promise.resolve({
          id: "frontend-none",
          label: "Terminal Frontend",
          ok: false,
          detail: "missions cannot launch without a terminal frontend",
          fix: "Configure a frontend in global settings or operations",
        })
      );
    }

    const useDefaultLinear = linearRepositories.length === 0
      && (projects ?? []).length === 0
      && (operations ?? []).length === 0
      && settings?.defaults.tracker === "linear";
    if (linearRepositories.length > 0 || useDefaultLinear) {
      const routes = new Map<string, { workspace?: string; repo?: string }>();
      const repositories = [...new Set(linearRepositories)];
      const workspaceResults = await Promise.allSettled(repositories.map(async (repo) => {
        const timedRun: Run = (command, args, cwd) => runWithTimeout(run, command, args, cwd);
        const workspace = await readLinearWorkspace(repo, timedRun);
        return { workspace, repo };
      }));
      const failures: string[] = [];
      for (const result of workspaceResults) {
        if (result.status === "fulfilled") routes.set(result.value.workspace ?? "", result.value);
        else failures.push(messageOf(result.reason));
      }
      if (useDefaultLinear) routes.set("", {});
      if (failures.length > 0) {
        addCheck("linear-config", "Linear workspace configuration", Promise.resolve({
          ok: false,
          detail: failures.join("; "),
          fix: "Ensure each Linear project repository has a valid mission.linearWorkspace git setting",
        }));
      }
      for (const { workspace, repo } of routes.values()) {
        const label = workspace ? `Linear CLI (${workspace})` : "Linear CLI (default workspace)";
        const id = workspace ? `linear:${workspace}` : "linear";
        addCheck(id, label, runWithTimeout(
          run,
          "lin",
          workspace ? ["me", "--json", "--workspace", workspace] : ["me", "--json"],
        ).then((res) => {
          if (res.code !== 0) return {
            ok: false,
            detail: "Not authenticated or missing",
            fix: "Install Linear CLI and run `lin auth`",
          };
          let email: string | undefined;
          try {
            const viewer = JSON.parse(res.stdout)?.viewer;
            if (typeof viewer?.email === "string") email = viewer.email;
          } catch {}
          return {
            ok: true,
            detail: `${workspace ? `Workspace ${workspace}` : "Default workspace"}${email ? `; authenticated as ${email}` : ""}${repo ? ` (${repo})` : ""}`,
          };
        }));
      }
    }

    if (trackersInUse.has("github") || deliveriesInUse.has("github-pr")) {
      addCheck("github", "GitHub CLI", runWithTimeout(run, "gh", ["auth", "status"]).then((res) => {
        if (res.code === 0) return { ok: true, detail: "Authenticated" };
        return { ok: false, detail: "Not authenticated or missing", fix: "Install GitHub CLI and run `gh auth login`" };
      }));
    }

    if (frontendsInUse.has("orca")) {
      addCheck("orca", "Orca Frontend", (async () => {
        const version = await runWithTimeout(run, "orca", ["--version"]);
        if (version.code !== 0)
          return { ok: false, detail: "Not installed or failed", fix: "Ensure orca is in PATH" };
        const capability = await checkOrcaStartupCommand(run, process.cwd());
        return capability.supported
          ? { ok: true, detail: `${version.stdout.trim()}; supports startup commands` }
          : {
              ok: false,
              detail: `Installed (${version.stdout.trim()}), but ${capability.detail}`,
              fix: "Restore the host CLI extension exposing `orca worktree create --command`; upgrades may replace it",
            };
      })());
    }

    if (frontendsInUse.has("herdr")) {
      addCheck("herdr", "Herdr Frontend", runWithTimeout(run, "herdr", ["--version"]).then((res) => {
        if (res.code === 0) return { ok: true, detail: res.stdout.trim() };
        return { ok: false, detail: "Not installed or failed", fix: "Ensure herdr is in PATH" };
      }));
    }
  }

  const results = await Promise.all(checkPromises);

  return {
    checks: results,
    counts: {
      projects: projects?.length ?? 0,
      operations: operations?.length ?? 0,
      contacts,
      launched,
    },
  };
}
