import type { Operation, Settings } from "../core/types.ts";
import {
  PortError,
  type DeliveryPort,
  type FleetPort,
  type FrontendPort,
  type Ports,
  type Run,
  type TrackerPort,
} from "../ports.ts";
import { githubPrDelivery } from "./delivery-github-pr.ts";
import { localMergeDelivery } from "./delivery-local-merge.ts";
import { noneDelivery } from "./delivery-none.ts";
import { ompMissionFleet } from "./fleet-omp-mission.ts";
import { noneFleet } from "./fleet-none.ts";
import { noneFrontend } from "./frontend-none.ts";
import { customFrontend } from "./frontend-custom.ts";
import { herdrFrontend } from "./frontend-herdr.ts";
import { orcaFrontend } from "./frontend-orca.ts";
import { githubTracker } from "./tracker-github.ts";
import { linearTracker } from "./tracker-linear.ts";
import { noneTracker } from "./tracker-none.ts";

type AdapterContext = { operation: Operation; settings: Settings; run: Run; agentDir: string };

const TRACKER_ADAPTERS: Record<string, (c: AdapterContext) => TrackerPort> = {
  none: () => noneTracker(),
  linear: (c) => linearTracker(c.run),
  github: (c) => githubTracker(c.run),
};
const FLEET_ADAPTERS: Record<string, (c: AdapterContext) => FleetPort> = {
  none: () => noneFleet(),
  "omp-mission": (c) => ompMissionFleet({ agentDir: c.agentDir }),
};
const FRONTEND_ADAPTERS: Record<string, (c: AdapterContext) => FrontendPort> = {
  none: () => noneFrontend(),
  orca: (c) => orcaFrontend(c.run),
  herdr: (c) => herdrFrontend(c.run, c.operation.worktreeRoot ?? c.settings.worktrees.root),
  custom: (c) => customFrontend(c.run, { ...c.settings, worktrees: { root: c.operation.worktreeRoot ?? c.settings.worktrees.root } }),
};
const DELIVERY_ADAPTERS: Record<string, (c: AdapterContext) => DeliveryPort> = {
  none: (c) => noneDelivery(c.run),
  "github-pr": (c) => githubPrDelivery(c.run),
  "local-merge": (c) => localMergeDelivery(c.run),
};

function pick<T>(table: Record<string, (c: AdapterContext) => T>, kind: string, name: string, c: AdapterContext): T {
  const factory = table[name];
  if (!factory) throw new PortError("adapter-unavailable", `${kind} ${name} is not built yet`);
  return factory(c);
}

export function resolvePorts(operation: Operation, settings: Settings, run: Run, agentDir: string): Ports {
  const context: AdapterContext = { operation, settings, run, agentDir };
  return {
    tracker: pick(TRACKER_ADAPTERS, "tracker", operation.tracker, context),
    fleet: pick(FLEET_ADAPTERS, "fleet", operation.fleet, context),
    frontend: pick(FRONTEND_ADAPTERS, "frontend", operation.frontend, context),
    delivery: pick(DELIVERY_ADAPTERS, "delivery", operation.delivery, context),
  };
}
