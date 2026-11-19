import { ConflictError, InputError } from "./core/errors.ts";
import { lock } from "proper-lockfile";
import { join } from "node:path";
import { isRecord } from "./core/validate.ts";
import { operationDir } from "./paths.ts";
import { unmetBlockers } from "./core/graph.ts";
import { AGENT_WORK_STATES, type AgentWorkState, type Event } from "./core/types.ts";
import type { Run } from "./ports.ts";
import { appendEvent, readEvents, readFolded } from "./store/events.ts";
import { readOperation } from "./store/operations.ts";

export interface AgentWorkInput {
  coordinator: string;
  action: "claim" | "release" | "report" | "decide";
  ticket?: string;
  worker?: string;
  state?: AgentWorkState;
  summary?: string;
  verification?: string;
  commit?: string;
  choice?: string;
}

const lockOptions = { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } } as const;
const latestClaim = (events: Event[]): string | null => {
  let coordinator: string | null = null;
  for (const event of events) {
    if (event.kind === "agent-claim") coordinator = event.coordinator;
    else if (event.kind === "agent-release") coordinator = null;
  }
  return coordinator;
};

export function hasActiveAgentWork(events: Event[]): boolean {
  const reports = new Map<string, Extract<Event, { kind: "agent-report" }>>();
  for (const event of events) if (event.kind === "agent-report") reports.set(event.contact, event);
  return [...reports.values()].some((event) => event.state !== "integrated");
}

export async function agentWork(home: string, now: Date, opId: string, input: AgentWorkInput, run?: Run): Promise<string> {
  if (!input || !isRecord(input)) throw new InputError("agent work input must be an object");
  if (typeof input.coordinator !== "string" || !input.coordinator.trim()) throw new InputError("coordinator must be a non-empty string");
  if (!["claim", "release", "report", "decide"].includes(input.action)) throw new InputError(`unknown agent-work action ${String(input.action)}`);
  const dir = operationDir(home, opId);
  const releaseLock = await lock(join(dir, "operation.json"), lockOptions);
  try {
    const op = await readOperation(home, opId);
    if ((op.execution ?? "missions") !== "agent") throw new ConflictError(`${opId} is not an agent-execution operation`);
    const events = await readEvents(home, opId);
    if (events.some((event) => event.kind === "closed")) throw new ConflictError(`${opId} is closed`);
    const coordinator = input.coordinator.trim();
    const owner = latestClaim(events);
    if (input.action === "claim") {
      if (owner && owner !== coordinator) throw new ConflictError(`${opId} is owned by coordinator ${owner}; release it before claiming`);
      await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "agent-claim", coordinator });
      return `Claimed ${opId} for coordinator ${coordinator}.`;
    }
    if (owner !== coordinator) throw new ConflictError(`${opId} is owned by ${owner ?? "no coordinator"}; coordinator ${coordinator} cannot ${input.action}`);
    if (input.action === "release") {
      await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "agent-release", coordinator });
      return `Released ${opId} from coordinator ${coordinator}; running workers may still be active.`;
    }
    const ticket = input.ticket;
    const summary = input.summary;
    if (typeof ticket !== "string" || !ticket) throw new InputError("action requires ticket");
    if (typeof summary !== "string" || !summary.trim()) throw new InputError("action requires a useful summary");
    const contact = op.contacts.find((item) => item.ticket === ticket);
    if (!contact) throw new InputError(`No contact ${ticket} in ${opId}`);
    const folded = await readFolded(home, opId);
    if (unmetBlockers(op, folded.derived, ticket).length > 0)
      throw new ConflictError(`${ticket} is blocked by dependencies and cannot be assigned`);
    if (folded.derived.contacts[ticket]?.landed)
      throw new ConflictError(`${ticket} is already landed`);
    if (input.action === "decide") {
      if (contact.kind !== "decision") throw new InputError(`${ticket} is not a decision contact`);
      const choice = input.choice?.trim();
      if (!choice) throw new InputError("decision requires choice");
      if (contact.options && !contact.options.includes(choice)) throw new InputError(`choice must be one of: ${contact.options.join(", ")}`);
      await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "decided", contact: ticket, by: "agent", choice, rationale: summary.trim() });
      await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "landed", contact: ticket, via: "manual" });
      return `${ticket}: decision recorded and landed.`;
    }
    if (input.action !== "report") throw new InputError(`unknown agent-work action ${String(input.action)}`);
    const worker = typeof input.worker === "string" ? input.worker.trim() : "";
    const state = input.state;
    if (!worker) throw new InputError("report requires worker");
    if (![...AGENT_WORK_STATES].includes(state as AgentWorkState)) throw new InputError("report requires a valid state");
    if (contact.kind === "decision") throw new InputError(`${ticket} is a decision contact; use decide`);
    const reports = events.filter((event): event is Extract<Event, { kind: "agent-report" }> => event.kind === "agent-report" && event.contact === ticket);
    const previous = reports.at(-1);
    if (!previous && state !== "assigned") throw new ConflictError(`first report for ${ticket} must be assigned`);
    if (previous && previous.state === "integrated") throw new ConflictError(`${ticket} is already integrated`);
    if (previous && previous.coordinator !== coordinator && state !== "assigned")
      throw new ConflictError(`new coordinator must explicitly assign ${ticket} before reporting worker progress`);
    if (previous && previous.worker !== worker) {
      if (previous.coordinator === coordinator && previous.state !== "blocked" && previous.state !== "complete")
        throw new ConflictError(`${ticket} can only be reassigned after the previous worker blocks/completes or a new coordinator takes ownership`);
      if (state !== "assigned") throw new ConflictError(`reassignment of ${ticket} must begin in assigned state`);
    }
    if (state === "integrated") {
      if (typeof input.verification !== "string" || !input.verification.trim()) throw new InputError("integrated report requires verification text");
      if (typeof input.commit !== "string" || !/^[0-9a-f]{40}$/i.test(input.commit)) throw new InputError("integrated report requires a full commit SHA");
      if (!run) throw new ConflictError("git verification is unavailable");
      const sha = input.commit.toLowerCase();
      const branch = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], op.integration);
      if (branch.code !== 0 || branch.stdout.trim() !== op.base) throw new ConflictError(`integration checkout must be on base branch ${op.base}`);
      const resolved = await run("git", ["rev-parse", "--verify", `${sha}^{commit}`], op.integration);
      if (resolved.code !== 0 || resolved.stdout.trim().toLowerCase() !== sha) throw new ConflictError("reported commit is not a commit in the integration checkout");
      const ancestor = await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"], op.integration);
      if (ancestor.code !== 0) throw new ConflictError(`reported commit ${sha} is not an ancestor of integration HEAD`);
    }
    const event: Extract<Event, { kind: "agent-report" }> = {
      v: 1, at: now.toISOString(), kind: "agent-report", coordinator, contact: ticket,
      worker, state: state as AgentWorkState, summary: summary.trim(),
      ...(typeof input.verification === "string" ? { verification: input.verification } : {}),
      ...(typeof input.commit === "string" ? { commit: input.commit.toLowerCase() } : {}),
    };
    await appendEvent(home, opId, event);
    return `${ticket}: ${state}.`;
  } finally {
    await releaseLock();
  }
}
