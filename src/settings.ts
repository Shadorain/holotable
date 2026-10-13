import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_MODES,
  DELIVERIES,
  FLEETS,
  FRONTENDS,
  THEMES,
  THINKING_LEVELS,
  TRACKERS,
  type Access,
  type AiSettings,
  type Delivery,
  type Fleet,
  type Frontend,
  type Settings,
  type Theme,
  type ThinkingLevel,
  type Tracker,
} from "./core/types.ts";
import { invalidAt, isRecord } from "./core/validate.ts";
import { DEFAULT_WORKTREE_ROOT, worktreeRootProblem } from "./core/worktrees.ts";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  model: null,
  thinking: null,
  draft: null,
  decision: null,
  mission: null,
};

export const DEFAULT_SETTINGS: Settings = {
  access: "tailscale",
  port: 4848,
  cap: 8,
  pollMs: 5000,
  sampleMs: 60000,
  theme: "holo",
  cleanup: true,
  worktrees: { root: DEFAULT_WORKTREE_ROOT },
  defaults: { tracker: "none", fleet: "omp-mission", frontend: "none", delivery: "none" },
  ai: { ...DEFAULT_AI_SETTINGS },
};

export const SETTING_KEYS = [
  "access",
  "port",
  "cap",
  "pollMs",
  "sampleMs",
  "theme",
  "worktrees.root",
  "defaults.tracker",
  "defaults.fleet",
  "cleanup",
  "defaults.frontend",
  "defaults.delivery",
  "custom.terminal",
  "custom.focus",
  "custom.close",
  "ai.model",
  "ai.thinking",
  "ai.draft",
  "ai.decision",
  "ai.mission",
] as const;

/** Keys the running service only picks up after a restart. */
export const RESTART_KEYS: readonly string[] = [] as const;

function integerIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}


function numericSetting(key: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a non-negative integer`);
  return Number(value);
}

export function settingsFile(home: string): string {
  return join(home, "settings.json");
}

export function displaySettingsPath(home: string, homeDir = homedir()): string {
  const path = settingsFile(home);
  const prefix = homeDir.endsWith("/") ? homeDir : `${homeDir}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export function validateSettings(value: unknown, path = "settings.json"): Settings {
  const fail = invalidAt("settings", path);
  if (!isRecord(value)) return fail("expected a JSON object");
  const raw = value;
  let access: Access;
  if ("access" in raw) {
    if (typeof raw.access !== "string" || !(ACCESS_MODES as readonly string[]).includes(raw.access))
      return fail(`access must be one of: ${ACCESS_MODES.join(", ")}`);
    access = raw.access as Access;
  } else if ("host" in raw) {
    const hostVal = String(raw.host);
    access = hostVal === "127.0.0.1" || hostVal === "localhost" ? "local" : "network";
  } else {
    access = DEFAULT_SETTINGS.access;
  }
  const port = "port" in raw ? raw.port : DEFAULT_SETTINGS.port;
  if (port !== 0 && !integerIn(port, 1, 65535))
    return fail("port must be 0 or an integer from 1 to 65535");
  const cap = "cap" in raw ? raw.cap : DEFAULT_SETTINGS.cap;
  if (!integerIn(cap, 1, 64)) return fail("cap must be an integer from 1 to 64");
  const pollMs = "pollMs" in raw ? raw.pollMs : DEFAULT_SETTINGS.pollMs;
  if (!integerIn(pollMs, 1000, 60000))
    return fail("pollMs must be an integer from 1000 to 60000");
  const sampleMs = "sampleMs" in raw ? raw.sampleMs : DEFAULT_SETTINGS.sampleMs;
  if (!integerIn(sampleMs, 10000, 600000))
    return fail("sampleMs must be an integer from 10000 to 600000");
  const theme = "theme" in raw ? raw.theme : DEFAULT_SETTINGS.theme;
  if (typeof theme !== "string" || !(THEMES as readonly string[]).includes(theme))
    return fail(`theme must be one of: ${THEMES.join(", ")}`);
  const cleanup = "cleanup" in raw ? raw.cleanup : DEFAULT_SETTINGS.cleanup;
  if (typeof cleanup !== "boolean") return fail("cleanup must be a boolean");
  let worktrees = { ...DEFAULT_SETTINGS.worktrees };
  if ("worktrees" in raw) {
    if (!isRecord(raw.worktrees)) return fail("worktrees must be a JSON object");
    const root = raw.worktrees.root ?? DEFAULT_WORKTREE_ROOT;
    if (typeof root !== "string") return fail("worktrees.root must be a string");
    const problem = worktreeRootProblem(root);
    if (problem) return fail(`worktrees.root ${problem}`);
    worktrees = { root };
  }

  const defaultsValue = "defaults" in raw ? raw.defaults : undefined;
  let defaults = { ...DEFAULT_SETTINGS.defaults };
  if (defaultsValue !== undefined) {
    if (!isRecord(defaultsValue)) return fail("defaults must be a JSON object");
    const fields = defaultsValue;
    const pick = <T extends string>(
      key: string,
      allowed: readonly T[],
      field: keyof Settings["defaults"],
    ): T => {
      const member = fields[key];
      if (member === undefined) return DEFAULT_SETTINGS.defaults[field] as T;
      if (typeof member !== "string" || !(allowed as readonly string[]).includes(member))
        fail(`defaults.${key} must be one of: ${allowed.join(", ")}`);
      return member as T;
    };
    defaults = {
      tracker: pick<Tracker>("tracker", TRACKERS, "tracker"),
      fleet: pick<Fleet>("fleet", FLEETS, "fleet"),
      frontend: pick<Frontend>("frontend", FRONTENDS, "frontend"),
      delivery: pick<Delivery>("delivery", DELIVERIES, "delivery"),
    };
  }

  let custom: Settings["custom"];
  const customValue = "custom" in raw ? raw.custom : undefined;
  if (customValue !== undefined) {
    if (!isRecord(customValue)) return fail("custom must be a JSON object");
    const fields = customValue;
    custom = {};
    for (const key of ["terminal", "focus", "close"] as const) {
      const member = fields[key];
      if (member === undefined || member === "") continue;
      if (typeof member !== "string") return fail(`custom.${key} must be a non-empty string`);
      custom[key] = member;
    }
  }
  let ai: AiSettings = { ...DEFAULT_AI_SETTINGS };
  const aiValue = "ai" in raw ? raw.ai : undefined;
  if (aiValue !== undefined) {
    if (!isRecord(aiValue)) return fail("ai must be a JSON object");
    const fields = aiValue;
    const parseModel = (key: keyof AiSettings): string | null => {
      const member = fields[key];
      if (member === undefined || member === null) return null;
      if (typeof member !== "string") return fail(`ai.${key} must be a string or null`);
      const trimmed = member.trim();
      return trimmed === "" ? null : trimmed;
    };
    const parseThinking = (): string | null => {
      const member = fields.thinking;
      if (member === undefined || member === null) return null;
      if (typeof member !== "string") return fail("ai.thinking must be a string or null");
      const trimmed = member.trim();
      if (trimmed === "" || trimmed === "null" || trimmed === "none") return null;
      if (!(THINKING_LEVELS as readonly string[]).includes(trimmed as ThinkingLevel))
        return fail(`ai.thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
      return trimmed;
    };
    ai = {
      model: parseModel("model"),
      thinking: parseThinking(),
      draft: parseModel("draft"),
      decision: parseModel("decision"),
      mission: parseModel("mission"),
    };
  }

  const settings: Settings = { access, port, cap, pollMs, sampleMs, theme: theme as Theme, cleanup, worktrees, defaults, ai };
  if (custom) settings.custom = custom;
  return settings;
}

export function formatSettings(settings: Settings): string {
  const lines = [
    `  access: ${settings.access}`,
    `  port: ${settings.port}`,
    `  cap: ${settings.cap}`,
    `  pollMs: ${settings.pollMs}`,
    `  sampleMs: ${settings.sampleMs}`,
    `  theme: ${settings.theme}`,
    `  worktrees.root: ${settings.worktrees.root}`,
    `  defaults.tracker: ${settings.defaults.tracker}`,
    `  defaults.fleet: ${settings.defaults.fleet}`,
    `  defaults.frontend: ${settings.defaults.frontend}`,
    `  defaults.delivery: ${settings.defaults.delivery}`,
    `  cleanup: ${settings.cleanup}`,
    `  ai.model: ${settings.ai.model || "(unset)"}`,
    `  ai.thinking: ${settings.ai.thinking || "(unset)"}`,
    `  ai.draft: ${settings.ai.draft || "(unset)"}`,
    `  ai.decision: ${settings.ai.decision || "(unset)"}`,
    `  ai.mission: ${settings.ai.mission || "(unset)"}`,
  ];
  if (settings.custom) {
    lines.push(
      `  custom.terminal: ${settings.custom.terminal || "(unset)"}`,
      `  custom.focus: ${settings.custom.focus || "(unset)"}`,
      `  custom.close: ${settings.custom.close || "(unset)"}`,
    );
  }
  return `Holotable configuration:\n${lines.join("\n")}`;
}

export function setSettingKey(settings: Settings, key: string, value: string | null): Settings {
  if (!(SETTING_KEYS as readonly string[]).includes(key as (typeof SETTING_KEYS)[number]))
    throw new Error(`Unknown setting "${key}". Valid keys: ${SETTING_KEYS.join(", ")}`);
  const next: Settings = JSON.parse(JSON.stringify(settings));
  switch (key) {
    case "access": {
      if (value === null || !(ACCESS_MODES as readonly string[]).includes(value as Access))
        throw new Error(`access must be one of: ${ACCESS_MODES.join(", ")}`);
      next.access = value as Access;
      break;
    }
    case "port":
      if (value === null) throw new Error("port must be 0 or an integer from 1 to 65535");
      next.port = numericSetting("port", value);
      break;
    case "cap":
      if (value === null) throw new Error("cap must be an integer from 1 to 64");
      next.cap = numericSetting("cap", value);
      break;
    case "pollMs":
      if (value === null) throw new Error("pollMs must be an integer from 1000 to 60000");
      next.pollMs = numericSetting("pollMs", value);
      break;
    case "sampleMs":
      if (value === null) throw new Error("sampleMs must be an integer from 10000 to 600000");
      next.sampleMs = numericSetting("sampleMs", value);
      break;
    case "theme":
      next.theme = value as Theme;
      break;
    case "worktrees.root":
      if (value === null) throw new Error("worktrees.root must be a string");
      next.worktrees.root = value;
      break;
    case "defaults.tracker":
      next.defaults.tracker = value as Tracker;
      break;
    case "defaults.fleet":
      next.defaults.fleet = value as Fleet;
      break;
    case "defaults.frontend":
      next.defaults.frontend = value as Frontend;
      break;
    case "cleanup":
      if (value !== "true" && value !== "false") throw new Error("cleanup must be true or false");
      next.cleanup = value === "true";
      break;
    case "defaults.delivery":
      next.defaults.delivery = value as Delivery;
      break;
    case "ai.model":
    case "ai.draft":
    case "ai.decision":
    case "ai.mission": {
      const field = key.slice("ai.".length) as "model" | "draft" | "decision" | "mission";
      next.ai[field] =
        value === null || value === "" || value === "null" || value === "none" || value === "(unset)"
          ? null
          : value.trim();
      break;
    }
    case "ai.thinking": {
      next.ai.thinking =
        value === null || value === "" || value === "null" || value === "none" || value === "(unset)"
          ? null
          : value.trim();
      break;
    }
    default: {
      const field = key.slice("custom.".length) as "terminal" | "focus" | "close";
      next.custom = { ...next.custom, [field]: value ?? "" } as Settings["custom"];
      break;
    }
  }
  return validateSettings(next);
}
