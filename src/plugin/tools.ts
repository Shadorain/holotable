import { addContact, updateContact } from "../contacts.ts";
import { KINDS, type Kind, type Projection } from "../core/types.ts";
import { readSettings } from "../store/settings.ts";
import { loadProjection } from "../snapshot.ts";
import { projection } from "./client.ts";

const MAX_CHARS = 4000;

/** One line per contact plus a header; capped so a big board cannot flood the model. */
export function stateText(p: Projection): string {
  const queued = p.contacts.filter((c) => c.group === "queue").length;
  const head = `${p.operation.id} "${p.operation.name}" base=${p.operation.base} tracker=${p.operation.tracker} fleet=${p.operation.fleet} frontend=${p.operation.frontend} delivery=${p.operation.delivery} | ${p.header.open}/${p.header.cap} omp, ${queued} queued, ${p.contacts.length} contacts`;
  const lines: string[] = [head];
  let size = head.length;
  for (const [index, c] of p.contacts.entries()) {
    const blockers = c.blockedBy.length ? ` blockedBy=${c.blockedBy.map((b) => `${b.ticket}${b.landed ? "(landed)" : ""}`).join(",")}` : "";
    const line = `${c.ticket} ${c.zone} ${c.kind} ${c.state} ${c.detail}${blockers}`;
    if (size + line.length + 1 > MAX_CHARS - 40) {
      lines.push(`… ${p.contacts.length - index} more contacts`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

export interface GenericTool {
  name: string;
  label: string;
  description: string;
  approval: "read" | "write";
  /** JSON schema for the params object; hosts translate it into their own schema language. */
  params: Record<string, unknown>;
  loadMode?: "essential";
  defaultInactive: boolean;
  /** Resolves to the text result. Throws Error with a model-readable message on bad input or store errors. */
  execute(params: Record<string, unknown>): Promise<string>;
}

export interface ToolDeps {
  home: string;
  /** The host's selected operation; used when params.operation is absent. */
  current(): Promise<string | null> | string | null;
  now(): Date;
}

const OPT_STR = { type: "string" };

async function resolveOp(deps: ToolDeps, operation: unknown): Promise<string> {
  if (operation !== undefined && typeof operation !== "string") throw new Error("operation must be a string");
  const id = (operation as string | undefined) ?? (await deps.current());
  if (!id) throw new Error("No operation selected. Pass operation, or the operator selects one with /holotable use <id>.");
  return id;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optKind(params: Record<string, unknown>): Kind | undefined {
  const value = params.kind;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(KINDS as readonly string[]).includes(value))
    throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  return value as Kind;
}

function optStringList(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be a string array`);
  return value as string[];
}

/** Host-agnostic tool definitions: the OMP adapter wraps them with pi.zod, another host reuses them as-is. */
export function holotableToolDefs(deps: ToolDeps): { state: GenericTool; queue: GenericTool } {
  return {
    state: {
      name: "holotable_state",
      label: "Holotable state",
      description: "Read the campaign board: one line per contact with state and blockers. Read-only.",
      approval: "read",
      loadMode: "essential",
      defaultInactive: true,
      params: {
        type: "object",
        properties: { operation: { ...OPT_STR, description: "Operation id; defaults to the selected one" } },
        additionalProperties: false,
      },
      async execute(params) {
        const id = await resolveOp(deps, params.operation);
        // Prefer the live service projection (watcher-fed statuses); fall back to events alone.
        const view =
          (await projection(deps.home, id)) ??
          (await loadProjection(deps.home, id, await readSettings(deps.home), deps.now().getTime()));
        return stateText(view);
      },
    },
    queue: {
      name: "holotable_queue",
      label: "Holotable queue",
      description:
        "Propose work: add a contact to the queue or edit a queued one. Cannot launch, land, approve or touch a launched contact; the operator launches from the board.",
      approval: "write",
      defaultInactive: true,
      params: {
        type: "object",
        required: ["action", "ticket"],
        properties: {
          operation: OPT_STR,
          action: { type: "string", enum: ["add", "update"] },
          ticket: { type: "string" },
          zone: OPT_STR,
          kind: { type: "string", enum: [...KINDS] },
          blockedBy: { type: "array", items: OPT_STR },
          title: { ...OPT_STR, description: "Short label, not full task instructions" },
          description: { type: ["string", "null"], description: "Full task scope and acceptance criteria; null clears it" },
          options: { type: "array", items: OPT_STR, description: "Decision contacts only: the choices to pick from" },
          recommended: { ...OPT_STR, description: "Decision contacts only: the suggested option" },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const action = requireString(params, "action");
        if (action !== "add" && action !== "update") throw new Error(`action must be add or update (got ${action})`);
        const ticket = requireString(params, "ticket");
        const id = await resolveOp(deps, params.operation);
        const zone = optString(params, "zone");
        const kind = optKind(params);
        const blockedBy = optStringList(params, "blockedBy");
        const title = optString(params, "title");
        const description = params.description === null ? null : optString(params, "description");
        const options = optStringList(params, "options");
        const recommended = optString(params, "recommended");
        if (action === "add") {
          if (!zone) throw new Error("zone is required to add a contact");
          const added = await addContact(deps.home, deps.now(), id, {
            source: "model",
            ticket,
            zone,
            ...(kind ? { kind } : {}),
            ...(blockedBy ? { blockedBy } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(options !== undefined ? { options } : {}),
            ...(recommended !== undefined ? { recommended } : {}),
          });
          return `${added.ticket} queued in ${id}/${zone}.`;
        }
        const updated = await updateContact(
          deps.home,
          deps.now(),
          id,
          ticket,
          {
            ...(zone ? { zone } : {}),
            ...(kind ? { kind } : {}),
            ...(blockedBy ? { blockedBy } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(options !== undefined ? { options } : {}),
            ...(recommended !== undefined ? { recommended } : {}),
          },
          "model",
        );
        return `${updated.ticket} updated in ${id}.`;
      },
    },
  };
}
