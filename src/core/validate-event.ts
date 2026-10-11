import {
  CONTACT_EVENT_KINDS,
  SOURCES,
  FRONTENDS,
  OPERATION_EVENT_KINDS,
  type Event,
  type SampleFields,
} from "./types.ts";
import { enumPicker, invalidAt, isRecord } from "./validate.ts";

const LAUNCH_STEPS = ["repo", "workspace", "terminal", "socket"] as const;
const CLOSED_OUTCOMES = ["landed", "abandoned", "decision", "failed"] as const;
const LANDED_VIA = ["merge", "pr", "manual"] as const;
const LAND_OUTCOMES = ["clean", "conflict"] as const;

export function validateEvent(value: unknown, path = "events.jsonl"): Event {
  const fail = invalidAt("event", path);
  if (!isRecord(value)) return fail("expected a JSON object");
  if (value.v !== 1) return fail("v must be 1");
  if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at)))
    return fail("at must be an ISO-8601 timestamp");
  const at = value.at;
  const kind = value.kind;
  if (typeof kind !== "string") return fail("kind must be a string");

  const str = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.length === 0)
      return fail(`${field} must be a non-empty string`);
    return raw;
  };
  const inList = enumPicker(fail);

  if ((OPERATION_EVENT_KINDS as readonly string[]).includes(kind)) {
    if ("contact" in value) return fail(`${kind} must not carry a contact`);
    if (kind === "workflow") {
      const item = str("item");
      if (typeof value.done !== "boolean") return fail("done must be a boolean");
      return { v: 1, at, kind: "workflow", item, done: value.done };
    }
    if (kind === "auto") {
      if (typeof value.enabled !== "boolean") return fail("enabled must be a boolean");
      if (value.reason !== undefined && typeof value.reason !== "string")
        return fail("reason must be a string");
      return {
        v: 1,
        at,
        kind: "auto",
        enabled: value.enabled,
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
        by: inList("by", value.by, ["operator", "board"] as const),
      };
    }
    if (kind === "recover") {
      if (typeof value.enabled !== "boolean") return fail("enabled must be a boolean");
      return {
        v: 1,
        at,
        kind: "recover",
        enabled: value.enabled,
        by: inList("by", value.by, ["operator", "board"] as const),
      };
    }
    return {
      v: 1,
      at,
      kind: "closed",
      outcome: inList("outcome", value.outcome, CLOSED_OUTCOMES),
    };
  }
  if (!(CONTACT_EVENT_KINDS as readonly string[]).includes(kind))
    return fail(`unknown kind "${kind}"`);
  if (typeof value.contact !== "string" || value.contact.length === 0)
    return fail(`${kind} requires contact`);
  const base = { v: 1 as const, at, contact: value.contact };

  switch (kind) {
    case "queued":
      return value.source === undefined
        ? { ...base, kind: "queued" }
        : { ...base, kind: "queued", source: inList("source", value.source, SOURCES) };
    case "edited": {
      if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.some((f) => typeof f !== "string"))
        return fail("fields must be a non-empty array of strings");
      return { ...base, kind: "edited", source: inList("source", value.source, SOURCES), fields: [...value.fields] as string[] };
    }
    case "unblocked":
      return { ...base, kind: "unblocked" };
    case "socket-down":
      return { ...base, kind: "socket-down" };
    case "reaped":
      return { ...base, kind: "reaped" };
    case "removed":
      return { ...base, kind: "removed", worktree: str("worktree") };
    case "blocked": {
      if (!Array.isArray(value.by) || value.by.some((b) => typeof b !== "string"))
        return fail("by must be an array of strings");
      return { ...base, kind: "blocked", by: [...value.by] as string[] };
    }
    case "adopted":
      return value.source === undefined
        ? { ...base, kind: "adopted", worktree: str("worktree") }
        : { ...base, kind: "adopted", worktree: str("worktree"), source: inList("source", value.source, SOURCES) };
    case "launched": {
      const worktree = str("worktree");
      const frontend = inList("frontend", value.frontend, FRONTENDS);
      const t = value.terminal;
      if (!isRecord(t)) return fail("terminal must be an object");
      if (typeof t.handle !== "string" || t.handle.length === 0)
        return fail("terminal.handle must be a non-empty string");
      if (typeof t.incarnationId !== "string" || t.incarnationId.length === 0)
        return fail("terminal.incarnationId must be a non-empty string");
      return {
        ...base,
        kind: "launched",
        worktree,
        frontend,
        terminal: { handle: t.handle, incarnationId: t.incarnationId },
      };
    }
    case "launch-failed":
      return {
        ...base,
        kind: "launch-failed",
        step: inList("step", value.step, LAUNCH_STEPS),
        error: str("error"),
      };
    case "socket-up": {
      if (typeof value.generation !== "number" || !Number.isFinite(value.generation))
        return fail("generation must be a number");
      return { ...base, kind: "socket-up", generation: value.generation };
    }
    case "phase": {
      if (value.from !== null && value.from !== undefined && typeof value.from !== "string")
        return fail("from must be a string or null");
      return { ...base, kind: "phase", from: value.from ?? null, to: str("to") };
    }
    case "gate-armed":
      return { ...base, kind: "gate-armed", gate: str("gate") };
    case "decided": {
      if (typeof value.choice !== "string") return fail("choice must be a string");
      if (value.rationale !== undefined && typeof value.rationale !== "string") return fail("rationale must be a string");
      if (value.by !== "operator" && value.by !== "agent" && value.by !== "recommended") return fail('by must be "operator", "agent", or "recommended"');
      return {
        ...base,
        kind: "decided",
        choice: value.choice,
        ...(value.rationale !== undefined ? { rationale: value.rationale } : {}),
        by: value.by,
      };
    }
    case "operator": {
      if (typeof value.ok !== "boolean") return fail("ok must be a boolean");
      if (value.error !== undefined && typeof value.error !== "string")
        return fail("error must be a string");
      if (value.by !== undefined && value.by !== "auto" && value.by !== "recover") return fail('by must be "auto" or "recover"');
      return {
        ...base,
        kind: "operator",
        op: str("op"),
        ok: value.ok,
        ...(value.error !== undefined ? { error: value.error } : {}),
        ...(value.by !== undefined ? { by: value.by as "auto" | "recover" } : {}),
        ...(value.args !== undefined ? { args: isRecord(value.args) ? value.args : {} } : {}),
      };
    }
    case "land-attempt": {
      const outcome = inList("outcome", value.outcome, LAND_OUTCOMES);
      if (
        value.paths !== undefined &&
        (!Array.isArray(value.paths) || value.paths.some((p) => typeof p !== "string"))
      )
        return fail("paths must be an array of strings");
      return {
        ...base,
        kind: "land-attempt",
        outcome,
        ...(value.paths !== undefined ? { paths: [...value.paths] as string[] } : {}),
      };
    }
    case "conflict-opened":
      return {
        ...base,
        kind: "conflict-opened",
        conflictContact: str("conflictContact"),
      };
    case "landed":
      return { ...base, kind: "landed", via: inList("via", value.via, LANDED_VIA) };
    case "sample": {
      const sample: SampleFields = {};
      if (value.tracker !== undefined) {
        const tr = value.tracker;
        if (!isRecord(tr) || typeof tr.state !== "string")
          return fail("sample.tracker.state must be a string");
        if (tr.url !== null && tr.url !== undefined && typeof tr.url !== "string")
          return fail("sample.tracker.url must be a string or null");
        sample.tracker = { state: tr.state, url: tr.url ?? null };
      }
      if (value.delivery !== undefined) {
        const d = value.delivery;
        if (
          !isRecord(d) ||
          (d.url !== null && d.url !== undefined && typeof d.url !== "string") ||
          typeof d.state !== "string" ||
          typeof d.mergeable !== "string" ||
          typeof d.checks !== "string"
        )
          return fail("sample.delivery must have url, state, mergeable and checks");
        sample.delivery = {
          url: d.url ?? null,
          state: d.state,
          mergeable: d.mergeable,
          checks: d.checks,
        };
      }
      if (value.workers !== undefined) {
        if (typeof value.workers !== "number" || !Number.isFinite(value.workers))
          return fail("sample.workers must be a number");
        sample.workers = value.workers;
      }
      if (value.omp !== undefined) {
        if (typeof value.omp !== "number" || !Number.isFinite(value.omp))
          return fail("sample.omp must be a number");
        sample.omp = value.omp;
      }
      if (value.usage !== undefined) {
        const u = value.usage;
        if (!isRecord(u) || !isRecord(u.tokens))
          return fail("sample.usage must be {tokens, costUsd}");
        const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
        const tokens = {} as Record<(typeof keys)[number], number>;
        for (const k of keys) {
          if (typeof u.tokens[k] !== "number" || !Number.isFinite(u.tokens[k]))
            return fail(`sample.usage.tokens.${k} must be a number`);
          tokens[k] = u.tokens[k] as number;
        }
        if (u.costUsd !== null && u.costUsd !== undefined && typeof u.costUsd !== "number")
          return fail("sample.usage.costUsd must be a number or null");
        sample.usage = { tokens: tokens as NonNullable<SampleFields["usage"]>["tokens"], costUsd: (u.costUsd as number | null | undefined) ?? null };
      }
      return { ...base, kind: "sample", ...sample };
    }
  }
  return fail(`unknown kind "${kind}"`);
}
