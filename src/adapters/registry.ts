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
import { ompMissionRemoteFleet } from "./fleet-omp-mission-remote.ts";
import { noneFleet } from "./fleet-none.ts";
import { noneFrontend } from "./frontend-none.ts";
import { customFrontend } from "./frontend-custom.ts";
import { herdrFrontend } from "./frontend-herdr.ts";
import { orcaFrontend } from "./frontend-orca.ts";
import { orcaChatFrontend } from "./frontend-orca-chat.ts";
import { createRemotePlacement, orcaRemoteFrontend, type RemotePlacement } from "./frontend-orca-remote.ts";
import { remoteRun } from "./orca-exec.ts";
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
  "orca-chat": (c) => orcaChatFrontend(orcaFrontend(c.run, process.cwd(), { noTerminal: true }), c.run),
  herdr: (c) => herdrFrontend(c.run, c.operation.worktreeRoot ?? c.settings.worktrees.root),
  custom: (c) => customFrontend(c.run, { ...c.settings, worktrees: { root: c.operation.worktreeRoot ?? c.settings.worktrees.root } }),
};
const DELIVERY_ADAPTERS: Record<string, (c: AdapterContext) => DeliveryPort> = {
  none: (c) => noneDelivery(c.run),
  "github-pr": (c) => githubPrDelivery(c.run),
  "local-merge": (c) => localMergeDelivery(c.run),
};

// Remote variants: everything that touches operation paths runs on the execution host through the
// authenticated relay instead of the ambient local Run. Tracker stays local (tracker CLIs/APIs are
// host-independent); frontend/fleet/delivery and Ports.run go remote.
function remotePorts(operation: Operation, settings: Settings, run: Run, agentDir: string): Ports {
  if (operation.frontend !== "orca" && operation.frontend !== "orca-chat")
    throw new PortError("placement-invalid", `Execution host requires an Orca frontend, not "${operation.frontend}"`);
  if (operation.fleet !== "omp-mission" && operation.fleet !== "none")
    throw new PortError("placement-invalid", `Execution host requires fleet "omp-mission" or "none", not "${operation.fleet}"`);
  const placement = createRemotePlacement(run, process.cwd(), {
    host: operation.host!,
    ...(operation.hostSetup ? { hostSetup: operation.hostSetup } : {}),
    repo: operation.repo,
  });
  const remoteCtx: AdapterContext = { operation, settings, run: remoteRunFor(placement, run), agentDir };
  return {
    tracker: operation.tracker === "linear"
      ? linearTracker(run, { configRun: remoteCtx.run, cliCwd: process.cwd() })
      : pick(TRACKER_ADAPTERS, "tracker", operation.tracker, { operation, settings, run, agentDir }),
    frontend: operation.frontend === "orca-chat"
      ? orcaChatFrontend(orcaRemoteFrontend(run, placement, process.cwd(), { noTerminal: true }), run, process.cwd(), operation.host)
      : orcaRemoteFrontend(run, placement),
    fleet:
      operation.fleet === "omp-mission"
        ? ompMissionRemoteFleet({ relay: () => placement.relay() })
        : noneFleet(),
    delivery: pick(DELIVERY_ADAPTERS, "delivery", operation.delivery, remoteCtx),
    run: remoteCtx.run,
  };
}

// The operation's remote Run: argv executes on the mission host via the relay (exec anchor is the
// resolved setup checkout). Resolves the anchor lazily so building Ports stays synchronous.
function remoteRunFor(placement: RemotePlacement, run: Run): Run {
  return async (command, args, cwd, env) => {
    const relay = await placement.relay();
    return relay.run(command, args, cwd, env);
  };
}

function pick<T>(table: Record<string, (c: AdapterContext) => T>, kind: string, name: string, c: AdapterContext): T {
  const factory = table[name];
  if (!factory) throw new PortError("adapter-unavailable", `${kind} ${name} is not built yet`);
  return factory(c);
}

export function resolvePorts(operation: Operation, settings: Settings, run: Run, agentDir: string): Ports {
  // Absent or explicit "local" is the board host; only ssh:/runtime: hosts route through the relay.
  if (operation.host !== undefined && operation.host !== "local") return remotePorts(operation, settings, run, agentDir);
  const context: AdapterContext = { operation, settings, run, agentDir };
  return {
    tracker: pick(TRACKER_ADAPTERS, "tracker", operation.tracker, context),
    fleet: pick(FLEET_ADAPTERS, "fleet", operation.fleet, context),
    frontend: pick(FRONTEND_ADAPTERS, "frontend", operation.frontend, context),
    delivery: pick(DELIVERY_ADAPTERS, "delivery", operation.delivery, context),
    run,
  };
}
