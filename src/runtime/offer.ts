import { actionOf, contactOf } from "../core/projection.ts";
import type { Contact, ContactView, Operation, Projection, Settings } from "../core/types.ts";
import { loadProjection } from "../snapshot.ts";
import { readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import type { LauncherDeps } from "./launcher.ts";

export interface Offered {
  settings: Settings;
  projection: Projection;
  view: ContactView;
  operation: Operation;
  contact: Contact | undefined;
}

/**
 * Same legality the board enforces: `action` exists and is enabled for `ticket` on a fresh projection,
 * else a 409 with the action's reason (`refusal` when it is not offered or gives none).
 */
export async function offered(
  deps: Pick<LauncherDeps, "home" | "now" | "settings" | "extras">,
  opId: string,
  ticket: string,
  action: string,
  refusal: string,
): Promise<Offered> {
  const settings = await deps.settings();
  const projection = await loadProjection(deps.home, opId, settings, deps.now().getTime(), deps.extras(opId));
  const view = contactOf(projection, ticket);
  const offer = actionOf(view, action);
  if (!view || !offer?.enabled) throw new ActionError(409, "refused", offer?.reason ?? refusal);
  const operation = await readOperation(deps.home, opId);
  return { settings, projection, view, operation, contact: contactOf(operation, ticket) };
}
