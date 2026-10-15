import { HOLDS, MODES, VERIFIES, type ContactStatus, type Hold, type Mode, type UsageTotals, type Verify } from "./types.ts";
import { invalidAt, isRecord } from "./validate.ts";

/** Producer-written status file contract (C5); unknown fields are ignored. */
export function validateStatus(
  value: unknown,
  path = "status.json",
): ContactStatus {
  const fail = invalidAt("status", path);
  if (!isRecord(value)) return fail("expected a JSON object");

  const str = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.length === 0)
      return fail(`${field} must be a non-empty string`);
    return raw;
  };
  const nullableStr = (field: string): string | null => {
    const raw = value[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") return fail(`${field} must be a string or null`);
    return raw;
  };

  if (value.schema !== 1) return fail("schema must be 1");
  const id = str("id");
  const ticket = str("ticket");
  if (typeof value.title !== "string") return fail("title must be a string");
  const worktree = str("worktree");
  const base = nullableStr("base");
  const phase = str("phase");

  const progress = value.progress;
  let prog: ContactStatus["progress"] = null;
  if (progress !== undefined && progress !== null) {
    if (
      !isRecord(progress) ||
      typeof progress.step !== "number" ||
      typeof progress.of !== "number"
    )
      return fail("progress must be {step, of} or null");
    prog = { step: progress.step, of: progress.of };
  }

  const hold = value.hold;
  if (typeof hold !== "string" || !(HOLDS as readonly string[]).includes(hold))
    return fail(`hold must be one of ${HOLDS.join(", ")}`);

  const gate = value.gate;
  let g: ContactStatus["gate"] = null;
  if (gate !== undefined && gate !== null) {
    if (
      !isRecord(gate) ||
      typeof gate.kind !== "string" ||
      typeof gate.id !== "string"
    )
      return fail("gate must be {kind, id} or null");
    g = { kind: gate.kind, id: gate.id };
  }

  const next = nullableStr("next");
  if (
    !Array.isArray(value.actions) ||
    value.actions.some((a) => typeof a !== "string")
  )
    return fail("actions must be an array of strings");
  const actions = [...value.actions] as string[];

  const workers = value.workers;
  let w: ContactStatus["workers"] = null;
  if (workers !== undefined && workers !== null) {
    if (
      !isRecord(workers) ||
      typeof workers.live !== "number" ||
      typeof workers.total !== "number"
    )
      return fail("workers must be {live, total} or null");
    w = { live: workers.live, total: workers.total };
  }

  const delivery = value.delivery;
  let del: ContactStatus["delivery"] = null;
  if (delivery !== undefined && delivery !== null) {
    if (
      !isRecord(delivery) ||
      (delivery.url !== null && typeof delivery.url !== "string") ||
      (delivery.branch !== null && typeof delivery.branch !== "string")
    )
      return fail("delivery must be {url, branch} or null");
    del = { url: delivery.url, branch: delivery.branch };
  }

  if (typeof value.complete !== "boolean")
    return fail("complete must be a boolean");
  const revision = str("revision");

  const ctl = value.ctl;
  let c: ContactStatus["ctl"] = null;
  if (ctl !== undefined && ctl !== null) {
    if (
      !isRecord(ctl) ||
      typeof ctl.socket !== "string" ||
      ctl.socket.length === 0 ||
      typeof ctl.generation !== "number"
    )
      return fail("ctl must be {socket, generation} or null");
    c = { socket: ctl.socket, generation: ctl.generation };
  }

  const plan = value.plan;
  let pl: ContactStatus["plan"] = null;
  if (plan !== undefined && plan !== null) {
    if (!isRecord(plan) || typeof plan.path !== "string" || typeof plan.revision !== "string")
      return fail("plan must be {path, revision} or null");
    pl = { path: plan.path, revision: plan.revision };
  }

  // Optional producer additions (B4): absent or null both read as "unknown".
  let mode: Mode | null = null;
  if (value.mode !== undefined && value.mode !== null) {
    if (typeof value.mode !== "string" || !(MODES as readonly string[]).includes(value.mode))
      return fail(`mode must be one of ${MODES.join(", ")} or null`);
    mode = value.mode as Mode;
  }
  let usage: UsageTotals | null = null;
  if (value.usage !== undefined && value.usage !== null) {
    const u = value.usage;
    if (!isRecord(u) || !isRecord(u.tokens)) return fail("usage must be {tokens, costUsd, sessions} or null");
    const numberIn = (raw: unknown): number | null =>
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
    const tokens = {
      input: numberIn(u.tokens.input),
      output: numberIn(u.tokens.output),
      cacheRead: numberIn(u.tokens.cacheRead),
      cacheWrite: numberIn(u.tokens.cacheWrite),
    };
    if (tokens.input === null || tokens.output === null || tokens.cacheRead === null || tokens.cacheWrite === null)
      return fail("usage.tokens must carry input, output, cacheRead and cacheWrite numbers");
    if (u.costUsd !== null && u.costUsd !== undefined && numberIn(u.costUsd) === null)
      return fail("usage.costUsd must be a number or null");
    const sessions = numberIn(u.sessions);
    usage = { tokens: tokens as UsageTotals["tokens"], costUsd: (u.costUsd as number | null) ?? null, sessions: sessions ?? 0 };
  }
  let verify: Verify | null = null;
  if (value.verify !== undefined && value.verify !== null) {
    if (typeof value.verify !== "string" || !(VERIFIES as readonly string[]).includes(value.verify))
      return fail(`verify must be one of ${VERIFIES.join(", ")}`);
    verify = value.verify as Verify;
  }

  let problem: ContactStatus["problem"] = null;
  if (value.problem !== undefined && value.problem !== null) {
    const p = value.problem;
    if (!isRecord(p) || !["quota", "rate-limit", "timeout", "error"].includes(String(p.kind)) ||
        typeof p.source !== "string" || !p.source || typeof p.detail !== "string" || !p.detail)
      return fail("problem must carry kind, source and detail");
    if (p.retryAt !== null && (typeof p.retryAt !== "string" || !Number.isFinite(Date.parse(p.retryAt))))
      return fail("problem.retryAt must be an ISO timestamp or null");
    const count = (key: string): number | null => {
      const n = p[key];
      if (n === null) return null;
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return fail(`problem.${key} must be a nonnegative integer or null`);
      return n;
    };
    problem = {
      kind: p.kind as NonNullable<ContactStatus["problem"]>["kind"],
      source: p.source, detail: p.detail, retryAt: p.retryAt as string | null,
      attempt: count("attempt"), completed: count("completed"), total: count("total"),
    };
  }

  let check: ContactStatus["check"] = null;
  if (value.check !== undefined && value.check !== null) {
    const k = value.check;
    const states = ["clean", "merged", "closed", "conflict", "threads", "checks", "fixing", "unknown"];
    if (!isRecord(k) || typeof k.at !== "string" || !Number.isFinite(Date.parse(k.at)) || !states.includes(String(k.state)) ||
        typeof k.detail !== "string" || !Array.isArray(k.conflicts) || k.conflicts.some((p) => typeof p !== "string") ||
        !isRecord(k.threads))
      return fail("check must carry at, state, detail, conflicts and threads");
    const { open, total } = k.threads;
    if (typeof open !== "number" || !Number.isSafeInteger(open) || open < 0 || typeof total !== "number" || !Number.isSafeInteger(total) || total < open)
      return fail("check.threads must be {open, total} nonnegative integers");
    check = { at: k.at, state: k.state as NonNullable<ContactStatus["check"]>["state"], detail: k.detail, conflicts: k.conflicts as string[], threads: { open, total } };
  }

  const updatedAt = str("updatedAt");
  return {
    schema: 1,
    id,
    ticket,
    title: value.title,
    worktree,
    base,
    phase,
    progress: prog,
    hold: hold as Hold,
    gate: g,
    next,
    actions,
    workers: w,
    delivery: del,
    complete: value.complete,
    revision,
    ctl: c,
    updatedAt,
    plan: pl,
    mode,
    usage,
    verify,
    ...(value.problem === undefined ? {} : { problem }),
    ...(value.check === undefined ? {} : { check }),
  };
}
