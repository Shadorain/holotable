import { stat } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./paths.ts";
import { listOperations } from "./store/operations.ts";
import { listProjects } from "./store/projects.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { readSettings } from "./store/settings.ts";
import type { Run } from "./ports.ts";
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
    return { code: -1, stdout: "", stderr: "", detail: error instanceof Error ? error.message : String(error) };
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
      detail: `Failed to list operations: ${error instanceof Error ? error.message : String(error)}`,
      fix: `Inspect the operation documents under ${join(home, "operations")} and fix or remove the invalid one`,
    }));
    return null;
  });

  const projects = await listProjects(home).catch((error: unknown) => {
    checkPromises.push(Promise.resolve({
      id: "projects-store",
      label: "Projects Store",
      ok: false,
      detail: `Failed to list projects: ${error instanceof Error ? error.message : String(error)}`,
      fix: `Inspect the project.json files under ${join(home, "projects")} and fix or remove the invalid one`,
    }));
    return null;
  });

  let contacts = 0;
  let launched = 0;

  const trackersInUse = new Set<string>();
  const frontendsInUse = new Set<string>();
  const deliveriesInUse = new Set<string>();

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
      contacts += p.contacts.length;
      launched += p.contacts.filter((c) => c.lane !== null).length;
    } catch (error) {
      checkPromises.push(Promise.resolve({
        id: `operation-${row.id}`,
        label: `Operation ${row.id}`,
        ok: false,
        detail: `Failed to load operation "${row.id}": ${error instanceof Error ? error.message : String(error)}`,
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
        detail: err instanceof Error ? err.message : String(err),
      }))
    );
  };

  if (run) {
    addCheck("omp", "OMP CLI", runWithTimeout(run, "omp", ["--version"]).then((res) => {
      if (res.code === 0) return { ok: true, detail: res.stdout.trim() };
      return {
        ok: false,
        detail: (res.detail ?? res.stderr.trim()) || "omp not found",
        fix: "Install OMP globally (e.g. npm i -g @oh-my-pi/pi-coding-agent)",
      };
    }));

    addCheck("omp-mission", "OMP Mission Extension", (async () => {
      const p = await runWithTimeout(run, "omp", ["plugin", "list", "--json"]);
      if (p.code === 0) {
        try {
          const parsed = JSON.parse(p.stdout);
          const npmPlugins = Array.isArray(parsed?.npm) ? parsed.npm : [];
          if (npmPlugins.some((pl: unknown) => typeof pl === "object" && pl !== null && "name" in pl && typeof pl.name === "string" && pl.name === "omp-mission")) {
            return { ok: true, detail: "Installed" };
          }
        } catch {
          // Fall back to manual check
        }
      }
      
      // Linked or copied extensions live in <agentDir>/extensions, where omp loads them from.
      const linked = await stat(join(agentDir(), "extensions", "omp-mission")).then(() => true).catch(() => false);
      if (linked) return { ok: true, detail: "Installed as an extension" };

      return {
        ok: false,
        detail: "launched omp sessions will not open a mission plan without it",
        fix: "omp plugin link <path to your omp-mission checkout>",
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

    if (trackersInUse.has("linear")) {
      addCheck("linear", "Linear CLI", runWithTimeout(run, "lin", ["me", "--json"]).then((res) => {
        if (res.code === 0) return { ok: true, detail: "Authenticated" };
        return { ok: false, detail: "Not authenticated or missing", fix: "Install Linear CLI and run `lin auth`" };
      }));
    }

    if (trackersInUse.has("github") || deliveriesInUse.has("github-pr")) {
      addCheck("github", "GitHub CLI", runWithTimeout(run, "gh", ["auth", "status"]).then((res) => {
        if (res.code === 0) return { ok: true, detail: "Authenticated" };
        return { ok: false, detail: "Not authenticated or missing", fix: "Install GitHub CLI and run `gh auth login`" };
      }));
    }

    if (frontendsInUse.has("orca")) {
      addCheck("orca", "Orca Frontend", runWithTimeout(run, "orca", ["--version"]).then((res) => {
        if (res.code === 0) return { ok: true, detail: res.stdout.trim() };
        return { ok: false, detail: "Not installed or failed", fix: "Ensure orca is in PATH" };
      }));
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
