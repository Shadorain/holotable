import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { ACCESS_MODES, DELIVERIES, FLEETS, FRONTENDS, KINDS, THEMES, THINKING_LEVELS, TRACKERS } from "./core/types.ts";
export interface CompletionSnapshot {
  operations: Array<{ id: string; name: string; archived: boolean }>;
  current: { id: string; zones: string[]; tickets: string[] } | null;
  projects: Array<{ id: string; name: string }>;
}

const SUBS: Array<{ name: string; description: string }> = [
  { name: "new", description: "Create an operation" },
  { name: "list", description: "List operations" },
  { name: "project", description: "Manage projects" },
  { name: "use", description: "Select an operation" },
  { name: "zone", description: "Add a zone to the selected operation" },
  { name: "set", description: "Change a field of the selected operation" },
  { name: "add", description: "Add a contact to the selected operation" },
  { name: "close", description: "Close and archive an operation" },
  { name: "config", description: "Show or set board settings" },
  { name: "start", description: "Start or reuse the board" },
  { name: "restart", description: "Restart the board; keep missions and data" },
  { name: "status", description: "Show board health" },
  { name: "url", description: "Show board URLs" },
  { name: "stop", description: "Stop the board" },
  { name: "help", description: "Show usage" },
];

const SET_VALUES: Record<string, readonly string[]> = {
  name: [],
  base: [],
  integration: [],
  pause: ["true", "false"],
  ignoreChecks: ["true", "false"],
  tracker: TRACKERS,
  fleet: FLEETS,
  frontend: FRONTENDS,
  delivery: DELIVERIES,
  recover: ["on", "off"],
  "auto.decide": ["on", "off"],
  worktreeRoot: ["default"],
};
const CONFIG_VALUES: Record<string, readonly string[]> = {
  access: ACCESS_MODES,
  port: [],
  cap: Array.from({ length: 64 }, (_, i) => String(i + 1)),
  pollMs: [],
  sampleMs: [],
  theme: THEMES,
  "worktrees.root": [],
  "defaults.tracker": TRACKERS,
  "defaults.fleet": FLEETS,
  "defaults.frontend": FRONTENDS,
  "defaults.delivery": DELIVERIES,
  "defaults.pause": ["auto", "pause", "false", "true"],
  "custom.terminal": [],
  "custom.focus": [],
  "custom.close": [],
  "ai.model": [],
  "ai.thinking": THINKING_LEVELS,
  "ai.draft": [],
  "ai.decision": [],
  "ai.mission": [],
};
const CLOSE_OUTCOMES = ["landed", "abandoned", "decision", "failed"];

function item(value: string, label: string, description?: string): AutocompleteItem {
  return { value, label, ...(description ? { description } : {}) };
}
function prefixMatches(prefix: string, name: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}
function orNull(items: AutocompleteItem[]): AutocompleteItem[] | null {
  return items.length ? items : null;
}

function splitRest(rest: string): { done: string[]; partial: string } {
  const parts = rest.split(" ").filter((part) => part.length > 0);
  const partial = rest.endsWith(" ") ? "" : (parts.pop() ?? "");
  return { done: parts, partial };
}

/** Completes `--flag` names and per-flag values for `new` and `add`. */
function completeFlags(
  verb: string,
  rest: string,
  valued: Record<string, readonly string[]>,
  booleans: string[],
): AutocompleteItem[] | null {
  const { done, partial } = splitRest(rest);
  const head = done.length ? `${done.join(" ")} ` : "";
  const prev = done[done.length - 1];
  const candidates = prev?.startsWith("--") ? valued[prev.slice(2)] : undefined;
  if (candidates) {
    // Comma lists (--blocked-by A,B) complete their last element.
    const picked = partial.split(",");
    const last = picked.pop() ?? "";
    const base = picked.length ? `${picked.join(",")},` : "";
    return orNull(
      candidates
        .filter((value) => prefixMatches(last, value) && !picked.includes(value))
        .map((value) => item(`${verb} ${head}${base}${value} `, value)),
    );
  }
  if (!partial.startsWith("--") && partial !== "") return null;
  const used = new Set(done.filter((token) => token.startsWith("--")));
  const names = [...Object.keys(valued), ...booleans].map((name) => `--${name}`);
  return orNull(
    names
      .filter((name) => (!used.has(name) || name === "--option") && prefixMatches(partial, name))
      .map((name) => item(`${verb} ${head}${name} `, name)),
  );
}

export function holotableCompletions(
  argumentPrefix: string,
  snapshot: CompletionSnapshot,
): AutocompleteItem[] | null {
  const space = argumentPrefix.indexOf(" ");
  if (space === -1)
    return orNull(
      SUBS.filter((sub) => prefixMatches(argumentPrefix, sub.name)).map((sub) =>
        item(`${sub.name} `, sub.name, sub.description),
      ),
    );
  const verb = argumentPrefix.slice(0, space).toLowerCase();
  const rest = argumentPrefix.slice(space + 1);
  const { done, partial } = splitRest(rest);
  const open = snapshot.operations.filter((op) => !op.archived);

  switch (verb) {
    case "use":
      if (done.length) return null;
      return orNull(
        open
          .filter((op) => prefixMatches(partial, op.id) || prefixMatches(partial, op.name))
          .map((op) => item(`use ${op.id} `, op.id, op.name)),
      );
    case "close": {
      if (done.length === 0)
        return orNull(
          open.filter((op) => prefixMatches(partial, op.id)).map((op) => item(`close ${op.id} `, op.id, op.name)),
        );
      if (done.length !== 1) return null;
      return orNull(
        CLOSE_OUTCOMES.filter((name) => prefixMatches(partial, name)).map((name) =>
          item(`close ${done[0]} ${name} `, name),
        ),
      );
    }
    case "set": {
      if (done.length === 0)
        return orNull(
          Object.keys(SET_VALUES)
            .filter((name) => prefixMatches(partial, name))
            .map((name) => item(`set ${name} `, name)),
        );
      if (done.length !== 1) return null;
      return orNull(
        (SET_VALUES[done[0] as string] ?? [])
          .filter((value) => prefixMatches(partial, value))
          .map((value) => item(`set ${done[0]} ${value} `, value)),
      );
    }
    case "config": {
      if (done.length === 0)
        return orNull(
          Object.keys(CONFIG_VALUES)
            .filter((name) => prefixMatches(partial, name))
            .map((name) => item(`config ${name} `, name)),
        );
      if (done.length !== 1) return null;
      return orNull(
        (CONFIG_VALUES[done[0] as string] ?? [])
          .filter((value) => prefixMatches(partial, value))
          .map((value) => item(`config ${done[0]} ${value} `, value)),
      );
    }
    case "new":
      return completeFlags(
        "new",
        rest,
        { repo: [], base: [], name: [], tracker: TRACKERS, fleet: FLEETS, frontend: FRONTENDS, delivery: DELIVERIES, from: [], integration: [], project: snapshot.projects.map((p) => p.id), brief: [] },
        ["no-pause", "pause", "auto", "recover"],
      );
    case "project": {
      const subs = ["new", "list", "set", "attach", "detach", "delete"];
      if (done.length === 0)
        return orNull(subs.filter((s) => prefixMatches(partial, s)).map((s) => item(`project ${s} `, s)));
      switch (done[0]) {
        case "new":
          return completeFlags("project new", rest, { repo: [], base: [], name: [], tracker: TRACKERS, fleet: FLEETS, frontend: FRONTENDS, delivery: DELIVERIES, integration: [] }, ["no-pause", "pause"]);
        case "set":
          if (done.length !== 1) return null;
          return orNull(
            ["name", "repo", "base", "integration", "pause", "tracker", "fleet", "frontend", "delivery", "worktreeRoot", "ignoreChecks"]
              .filter((name) => prefixMatches(partial, name))
              .map((name) => item(`project set ${name} `, name)),
          );
        case "attach":
        case "delete":
          if (done.length !== 1) return null;
          return orNull(
            snapshot.projects
              .filter((p) => prefixMatches(partial, p.id) || prefixMatches(partial, p.name))
              .map((p) => item(`project ${done[0]} ${p.id} `, p.id, p.name)),
          );
        case "detach":
          return null;
        default:
          return null;
      }
    }
    case "add":
      return completeFlags(
        "add",
        rest,
        {
          zone: snapshot.current?.zones ?? [],
          kind: KINDS,
          "blocked-by": snapshot.current?.tickets ?? [],
          title: [],
          worktree: [],
          option: [],
          recommended: [],
        },
        [],
      );
    default:
      return null;
  }
}
