import { worktreeRootProblem } from "./worktrees.ts";
import { findCycle } from "./graph.ts";
import {
  DELIVERIES,
  FLEETS,
  FRONTENDS,
  KINDS,
  OVERRIDABLE_FIELDS,
  TRACKERS,
  type Contact,
  type Kind,
  type Lane,
  type Operation,
  type OverridableField,
  type Project,
  type StoredOperation,
  type TerminalRef,
  type Tracker,
  type Zone,
} from "./types.ts";
import { enumPicker, invalidAt, isRecord, MAX_OPERATION_BYTES } from "./validate.ts";

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ZONE_ID_RE = /^[a-z0-9-]{1,24}$/;
const WORKFLOW_ID_RE = /^[a-z0-9-]{1,32}$/;
const LINEAR_TICKET_RE = /^[A-Za-z]{2,5}-\d{1,5}$/;
const GITHUB_TICKET_RE = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+$/;
const FREEFORM_TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Canonical stored form of a ticket for a tracker: linear upper-cases. */
export function normalizeTicket(tracker: Tracker, ticket: string): string {
  const t = ticket.trim();
  return tracker === "linear" ? t.toUpperCase() : t;
}

/** Whether `ticket` names an issue in `tracker` (any short id when there is no tracker). */
export function trackerTicket(tracker: Tracker, ticket: string): boolean {
  switch (tracker) {
    case "linear":
      return LINEAR_TICKET_RE.test(ticket);
    case "github":
      return GITHUB_TICKET_RE.test(ticket);
    case "none":
      return FREEFORM_TICKET_RE.test(ticket);
  }
}

export interface OperationDoc {
  /** The normalized on-disk shape (absent overridable keys stay absent). */
  stored: StoredOperation;
  /** The effective operation: stored values over the project's. */
  operation: Operation;
  /** Overridable fields this operation takes from its project. */
  inherited: OverridableField[];
}

/**
 * Parse and validate an operation.json. With `project` (the project `stored.project` names),
 * absent overridable fields resolve from it; without one every overridable field must be present
 * (a standalone operation, or an archived one written resolved).
 */
export function validateOperationDoc(
  value: unknown,
  path = "operation.json",
  project: Project | null = null,
): OperationDoc {
  const fail = invalidAt("operation", path);
  if (!isRecord(value)) return fail("expected a JSON object");

  if (value.v !== 1) return fail("v must be 1");
  if (typeof value.id !== "string" || !ID_RE.test(value.id))
    return fail("id must match ^[a-z0-9][a-z0-9-]{0,47}$");
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80)
    return fail("name must be 1-80 characters");
  if (
    value.project !== undefined &&
    value.project !== null &&
    (typeof value.project !== "string" || !ID_RE.test(value.project))
  )
    return fail("project must be a project id or null");
  const projectId = (value.project as string | null | undefined) ?? null;
  if (projectId !== null && project !== null && project.id !== projectId)
    return fail(`project "${projectId}" does not match the supplied project "${project.id}"`);

  const enumOf = enumPicker(fail);

  // Every overridable field validates when present, then resolves from the project when absent.
  const doc: Record<OverridableField, unknown> = {} as Record<OverridableField, unknown>;
  const raw = value as Record<string, unknown>;
  if (raw.repo !== undefined) {
    if (typeof raw.repo !== "string" || !raw.repo.startsWith("/"))
      return fail("repo must be an absolute path");
    doc.repo = raw.repo;
  }
  if (raw.base !== undefined) {
    if (typeof raw.base !== "string" || raw.base.length < 1 || raw.base.length > 200 || /\s/.test(raw.base))
      return fail("base must be 1-200 characters with no whitespace");
    doc.base = raw.base;
  }
  if (raw.integration !== undefined) {
    if (typeof raw.integration !== "string" || !raw.integration.startsWith("/"))
      return fail("integration must be an absolute path");
    doc.integration = raw.integration;
  }
  if (raw.pause !== undefined) {
    if (typeof raw.pause !== "boolean") return fail("pause must be a boolean");
    doc.pause = raw.pause;
  }
  if (raw.tracker !== undefined) doc.tracker = enumOf("tracker", raw.tracker, TRACKERS);
  if (raw.fleet !== undefined) doc.fleet = enumOf("fleet", raw.fleet, FLEETS);
  if (raw.frontend !== undefined) doc.frontend = enumOf("frontend", raw.frontend, FRONTENDS);
  if (raw.delivery !== undefined) doc.delivery = enumOf("delivery", raw.delivery, DELIVERIES);
  if (raw.worktreeRoot !== undefined) {
    if (typeof raw.worktreeRoot !== "string") return fail("worktreeRoot must be a string");
    const problem = worktreeRootProblem(raw.worktreeRoot);
    if (problem) return fail(`worktreeRoot ${problem}`);
    doc.worktreeRoot = raw.worktreeRoot;
  }
  if (raw.ignoreChecks !== undefined) {
    if (typeof raw.ignoreChecks !== "boolean") return fail("ignoreChecks must be a boolean");
    doc.ignoreChecks = raw.ignoreChecks;
  }

  // Legacy documents may still carry `workflow`: validate it so a malformed list
  // is rejected before the store's migration turns it into notes.md task lines.
  if (value.workflow !== undefined) {
    if (!Array.isArray(value.workflow)) return fail("workflow must be an array");
    if (value.workflow.length > 30) return fail("workflow must have at most 30 items");
    const workflowIds = new Set<string>();
    for (const [i, w] of value.workflow.entries()) {
      const at = `workflow[${i}]`;
      if (!isRecord(w)) return fail(`${at} must be an object`);
      if (typeof w.id !== "string" || !WORKFLOW_ID_RE.test(w.id))
        return fail(`${at}.id must match ^[a-z0-9-]{1,32}$`);
      if (workflowIds.has(w.id)) return fail(`${at}.id "${w.id}" is a duplicate`);
      workflowIds.add(w.id);
      if (typeof w.label !== "string" || w.label.length < 1 || w.label.length > 80)
        return fail(`${at}.label must be 1-80 characters`);
    }
  }

  const inherited: OverridableField[] = [];
  const effective = {} as Record<OverridableField, unknown>;
  for (const field of OVERRIDABLE_FIELDS) {
    if (doc[field] !== undefined) {
      effective[field] = doc[field];
      continue;
    }
    if (project !== null && projectId === project.id) {
      const fromProject = project[field as keyof Project];
      if (fromProject !== undefined) {
        effective[field] = fromProject;
        inherited.push(field);
        continue;
      }
    }
    // worktreeRoot alone may be absent everywhere: settings.worktrees.root applies then, and with a
    // project that still means "following the project", not an override.
    if (field === "worktreeRoot") {
      if (project !== null && projectId === project.id) inherited.push(field);
      continue;
    }
    // Operations written before `pause` or `ignoreChecks` existed behave as unpaused and blocking on checks.
    if (field === "pause" || field === "ignoreChecks") {
      effective[field] = false;
      if (project !== null && projectId === project.id) inherited.push(field);
      continue;
    }
    if (projectId !== null)
      return fail(`${field} is required: project "${projectId}" does not provide it`);
    return fail(field === "repo" || field === "integration" ? `${field} must be an absolute path` : `${field} is required`);
  }

  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  )
    return fail("createdAt must be an ISO-8601 timestamp");
  let auto: Operation["auto"];
  if (value.auto !== undefined && value.auto !== null) {
    if (!isRecord(value.auto)) return fail("auto must be a JSON object");
    const a = value.auto;
    for (const key of ["enabled", "launch", "land", "plans", "decide", "repairs", "reviews"] as const) {
      if ((key === "plans" || key === "decide" || key === "repairs" || key === "reviews") && a[key] === undefined) continue;
      if (typeof a[key] !== "boolean") return fail(`auto.${key} must be a boolean`);
    }
    if (typeof a.maxLive !== "number" || !Number.isInteger(a.maxLive) || a.maxLive < 1 || a.maxLive > 64)
      return fail("auto.maxLive must be an integer from 1 to 64");
    auto = {
      enabled: a.enabled as boolean,
      launch: a.launch as boolean,
      land: a.land as boolean,
      maxLive: a.maxLive as number,
      plans: (a.plans as boolean | undefined) ?? false,
      decide: (a.decide as boolean | undefined) ?? false,
      ...(a.repairs !== undefined ? { repairs: a.repairs as boolean } : {}),
      ...(a.reviews !== undefined ? { reviews: a.reviews as boolean } : {}),
    };
  }
  if (value.recover !== undefined && typeof value.recover !== "boolean")
    return fail("recover must be a boolean");
  const recover = value.recover === true;

  if (!Array.isArray(value.zones)) return fail("zones must be an array");
  if (value.zones.length > 8) return fail("zones must have at most 8 entries");
  const zones: Zone[] = [];
  const zoneIds = new Set<string>();
  for (const [i, z] of value.zones.entries()) {
    const at = `zones[${i}]`;
    if (!isRecord(z)) return fail(`${at} must be an object`);
    if (typeof z.id !== "string" || !ZONE_ID_RE.test(z.id))
      return fail(`${at}.id must match ^[a-z0-9-]{1,24}$`);
    if (zoneIds.has(z.id)) return fail(`${at}.id "${z.id}" is a duplicate`);
    zoneIds.add(z.id);
    if (typeof z.label !== "string" || z.label.length < 1 || z.label.length > 24)
      return fail(`${at}.label must be 1-24 characters`);
    zones.push({ id: z.id, label: z.label });
  }

  // Tickets normalize and validate against the effective tracker (it may come from the project).
  const tracker = effective.tracker as Tracker;
  if (!Array.isArray(value.contacts)) return fail("contacts must be an array");
  if (value.contacts.length > 200)
    return fail("contacts must have at most 200 entries");

  const isTicketOk = (ticket: string): boolean => trackerTicket(tracker, ticket);
  const ticketOk = (kind: Kind, ticket: string): boolean => {
    if (kind === "conflict") {
      const idx = ticket.lastIndexOf("-conflict-");
      if (idx >= 0 && /^\d+$/.test(ticket.slice(idx + 10))) {
        const base = ticket.slice(0, idx);
        return isTicketOk(base) || FREEFORM_TICKET_RE.test(base);
      }
      return FREEFORM_TICKET_RE.test(ticket);
    }
    // A closer is the board's own review, not a tracker issue: CLOSER is a valid ticket under any tracker.
    if (kind === "closer") return isTicketOk(ticket) || FREEFORM_TICKET_RE.test(ticket);
    return isTicketOk(ticket);
  };

  const contacts: Contact[] = [];
  const tickets = new Set<string>();
  for (const [i, c] of value.contacts.entries()) {
    const at = `contacts[${i}]`;
    if (!isRecord(c)) return fail(`${at} must be an object`);
    const kind =
      c.kind === undefined
        ? ("implement" as Kind)
        : enumOf(`${at}.kind`, c.kind, KINDS);
    if (typeof c.ticket !== "string" || c.ticket.trim().length === 0)
      return fail(`${at}.ticket must be a string`);
    const ticket = normalizeTicket(tracker, c.ticket);
    if (!ticketOk(kind, ticket))
      return fail(`${at}.ticket "${ticket}" is not a valid ${tracker} ticket`);
    if (tickets.has(ticket))
      return fail(`${at}.ticket "${ticket}" is a duplicate`);
    tickets.add(ticket);

    const title =
      c.title === undefined || c.title === null
        ? null
        : typeof c.title === "string"
          ? c.title
          : fail(`${at}.title must be a string or null`);
    const description =
      c.description === undefined || c.description === null
        ? null
        : typeof c.description === "string"
          ? c.description
          : fail(`${at}.description must be a string or null`);
    if (typeof c.zone !== "string" || !zoneIds.has(c.zone))
      return fail(`${at}.zone must name an existing zone`);
    if (!Array.isArray(c.blockedBy))
      return fail(`${at}.blockedBy must be an array`);
    const blockedBy: string[] = [];
    for (const b of c.blockedBy) {
      if (typeof b !== "string")
        return fail(`${at}.blockedBy entries must be strings`);
      blockedBy.push(normalizeTicket(tracker, b));
    }
    const conflictOf =
      c.conflictOf === undefined || c.conflictOf === null
        ? null
        : typeof c.conflictOf === "string"
          ? normalizeTicket(tracker, c.conflictOf)
          : fail(`${at}.conflictOf must be a string or null`);
    if (kind === "conflict" && conflictOf === null)
      return fail(`${at}.conflictOf is required for a conflict contact`);
    if (kind !== "conflict" && conflictOf !== null)
      return fail(`${at}.conflictOf is only allowed on conflict contacts`);

    let lane: Lane | null = null;
    if (c.lane !== undefined && c.lane !== null) {
      const l = c.lane;
      if (!isRecord(l)) return fail(`${at}.lane must be an object or null`);
      if (typeof l.worktree !== "string" || !l.worktree.startsWith("/"))
        return fail(`${at}.lane.worktree must be an absolute path`);
      const branch =
        l.branch === undefined || l.branch === null
          ? null
          : typeof l.branch === "string"
            ? l.branch
            : fail(`${at}.lane.branch must be a string or null`);
      const laneFrontend: Lane["frontend"] =
        l.frontend === "external"
          ? "external"
          : enumOf(`${at}.lane.frontend`, l.frontend, FRONTENDS);
      let terminal: TerminalRef | null = null;
      if (l.terminal !== undefined && l.terminal !== null) {
        const t = l.terminal;
        if (!isRecord(t))
          return fail(`${at}.lane.terminal must be an object or null`);
        if (typeof t.handle !== "string" || t.handle.length === 0)
          return fail(`${at}.lane.terminal.handle must be a non-empty string`);
        if (typeof t.incarnationId !== "string" || t.incarnationId.length === 0)
          return fail(`${at}.lane.terminal.incarnationId must be a non-empty string`);
        terminal = { handle: t.handle, incarnationId: t.incarnationId };
      }
      let model: string | null | undefined;
      if ("model" in l && l.model !== undefined) {
        if (l.model !== null && typeof l.model !== "string")
          return fail(`${at}.lane.model must be a string or null`);
        model = l.model;
      }
      lane = { worktree: l.worktree, branch, frontend: laneFrontend, terminal, ...(model !== undefined ? { model } : {}) };
    } else if ("terminal" in c) {
      return fail(`${at}.lane.terminal requires lane`);
    }
    if (kind !== "decision") {
      if ("options" in c) return fail(`${at}.options is only allowed for decision contacts`);
      if ("recommended" in c) return fail(`${at}.recommended is only allowed for decision contacts`);
    }
    let options: string[] | undefined;
    if ("options" in c && c.options !== undefined) {
      if (!Array.isArray(c.options)) return fail(`${at}.options must be an array of strings`);
      if (c.options.length < 2 || c.options.length > 8) return fail(`${at}.options must have 2 to 8 entries`);
      if (c.options.some((o) => typeof o !== "string" || o.length < 1 || o.length > 120)) return fail(`${at}.options entries must be strings of 1 to 120 chars`);
      if (new Set(c.options).size !== c.options.length) return fail(`${at}.options entries must be unique`);
      options = c.options;
    }
    let recommended: string | undefined;
    if ("recommended" in c && c.recommended !== undefined) {
      if (typeof c.recommended !== "string") return fail(`${at}.recommended must be a string`);
      if (!options || !options.includes(c.recommended)) return fail(`${at}.recommended must be one of options`);
      recommended = c.recommended;
    }
    contacts.push({ ticket, title, description, zone: c.zone, kind, blockedBy, conflictOf, lane, ...(options ? { options } : {}), ...(recommended ? { recommended } : {}) });
  }

  for (const [i, c] of contacts.entries()) {
    const at = `contacts[${i}]`;
    for (const b of c.blockedBy) {
      if (b === c.ticket) return fail(`${at}.blockedBy must not contain itself`);
      if (!tickets.has(b))
        return fail(`${at}.blockedBy "${b}" is not a contact ticket`);
    }
    if (c.conflictOf !== null && !tickets.has(c.conflictOf))
      return fail(`${at}.conflictOf "${c.conflictOf}" is not a contact ticket`);
    if (c.conflictOf === c.ticket)
      return fail(`${at}.conflictOf must not be itself`);
  }
  const closers = contacts.filter((c) => c.kind === "closer");
  if (closers.length > 1) return fail(`only one closer per operation (${closers.map((c) => c.ticket).join(", ")})`);
  const closer = closers[0];
  if (closer) {
    // Its blockers are implicit (every other contact), and nothing can wait on the operation's last contact.
    if (closer.blockedBy.length) return fail(`closer ${closer.ticket} must not list blockedBy: it waits for every other contact`);
    const waiting = contacts.find((c) => c.blockedBy.includes(closer.ticket));
    if (waiting) return fail(`${waiting.ticket} must not wait for closer ${closer.ticket}: the closer lands last`);
  }
  const cycle = findCycle(contacts);
  if (cycle) return fail(`blockedBy cycle: ${cycle.join(" -> ")}`);

  const stored: StoredOperation = {
    v: 1,
    id: value.id,
    name: value.name,
    project: projectId,
    zones,
    contacts,
    createdAt: value.createdAt,
    ...(doc.repo !== undefined ? { repo: doc.repo as string } : {}),
    ...(doc.base !== undefined ? { base: doc.base as string } : {}),
    ...(doc.integration !== undefined ? { integration: doc.integration as string } : {}),
    ...(doc.pause !== undefined ? { pause: doc.pause as boolean } : {}),
    ...(doc.tracker !== undefined ? { tracker: doc.tracker as StoredOperation["tracker"] } : {}),
    ...(doc.fleet !== undefined ? { fleet: doc.fleet as StoredOperation["fleet"] } : {}),
    ...(doc.frontend !== undefined ? { frontend: doc.frontend as StoredOperation["frontend"] } : {}),
    ...(doc.delivery !== undefined ? { delivery: doc.delivery as StoredOperation["delivery"] } : {}),
    ...(doc.worktreeRoot !== undefined ? { worktreeRoot: doc.worktreeRoot as string } : {}),
    ...(doc.ignoreChecks !== undefined ? { ignoreChecks: doc.ignoreChecks as boolean } : {}),
    ...(auto ? { auto } : {}),
    ...(recover ? { recover } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(stored)).length >= MAX_OPERATION_BYTES)
    return fail("serialized size must be under 1 MiB");

  const operation: Operation = {
    v: 1,
    id: stored.id,
    name: stored.name,
    project: projectId,
    repo: effective.repo as string,
    base: effective.base as string,
    integration: effective.integration as string,
    pause: effective.pause as boolean,
    tracker,
    fleet: effective.fleet as Operation["fleet"],
    frontend: effective.frontend as Operation["frontend"],
    delivery: effective.delivery as Operation["delivery"],
    ignoreChecks: effective.ignoreChecks as boolean,
    zones,
    contacts,
    createdAt: stored.createdAt,
    ...(effective.worktreeRoot !== undefined ? { worktreeRoot: effective.worktreeRoot as string } : {}),
    ...(auto ? { auto } : {}),
    recover,
  };
  return { stored, operation, inherited };
}

/** The resolved operation (all fields effective). Pass the project when the doc may inherit. */
export function validateOperation(
  value: unknown,
  path = "operation.json",
  project: Project | null = null,
): Operation {
  return validateOperationDoc(value, path, project).operation;
}

/** The normalized on-disk shape, for the write path. */
export function validateStoredOperation(
  value: unknown,
  path = "operation.json",
  project: Project | null = null,
): StoredOperation {
  return validateOperationDoc(value, path, project).stored;
}
