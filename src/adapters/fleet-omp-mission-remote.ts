import type { ContactStatus } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { validateStatus } from "../core/validate-status.ts";
import { PortError, type FleetPort } from "../ports.ts";
import { missionLaunch } from "./fleet-omp-mission.ts";
import type { RelayOps } from "./orca-exec.ts";

// omp-mission fleet for an explicitly placed (remote) operation. Every status read, socket call
// and process probe is relayed through `orca worktree exec` + the deployed mission relay on the
// execution host — nothing touches the board host's filesystem or /proc.

const PING_TIMEOUT_MS = 3_000;
const CONTROL_TIMEOUT_MS = 150_000;

// Same overlay text as store/launch.ts; the remote overlay lives on the mission host, so the
// board's local file cannot be used as launch input.
const OVERLAYS = {
  plan: { file: "plan-default.yml", text: "plan:\n  defaultOnStartup: true\n" },
  resume: { file: "resume.yml", text: "plan:\n  defaultOnStartup: false\n" },
} as const;

export interface RemoteMissionFleetOptions {
  /** Lazily resolves the deployed relay for this operation's host (anchored on the remote repo). */
  relay: () => Promise<RelayOps>;
  /** Called once per status file that fails validation. */
  onInvalidStatus?: (path: string, error: Error) => void;
}

export function ompMissionRemoteFleet(options: RemoteMissionFleetOptions): FleetPort {
  // A mission-level {error} reply reaches the caller as a thrown PortError (same shape the local
  // fleet throws after socketRequest); a success reply is the response object itself.
  async function ctl(socket: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const relay = await options.relay();
    return relay.request("ctl", { socket, payload, timeoutMs }, timeoutMs + 10_000);
  }

  async function read(i: { worktree: string }): Promise<ContactStatus | null> {
    const relay = await options.relay();
    const res = await relay.request("status", { worktree: i.worktree });
    const candidates = Array.isArray(res.candidates) ? res.candidates : [];
    let newest: { status: ContactStatus; updatedAt: number } | null = null;
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.path !== "string") continue;
      try {
        const status = validateStatus(candidate.status, `remote:${candidate.path}`);
        const updatedAt = Date.parse(status.updatedAt);
        if (Number.isNaN(updatedAt)) continue;
        if (!newest || updatedAt > newest.updatedAt) newest = { status, updatedAt };
      } catch (error) {
        options.onInvalidStatus?.(candidate.path, error as Error);
      }
    }
    return newest?.status ?? null;
  }

  async function ping(status: ContactStatus): Promise<boolean> {
    if (!status.ctl) return false;
    try {
      const reply = await ctl(status.ctl.socket, { v: 1, op: "ping" }, PING_TIMEOUT_MS);
      return reply.ok === true;
    } catch {
      return false;
    }
  }

  async function running(status: ContactStatus): Promise<boolean | null> {
    const session = status.session;
    if (!session) return null;
    try {
      const relay = await options.relay();
      const res = await relay.request("proc", { pid: session.pid });
      // Non-Linux hosts without /proc report unsupported: unavailable, not "dead".
      if (res.supported === false) return null;
      return typeof res.start === "string" && res.start === session.processStart;
    } catch {
      return null;
    }
  }

  async function control(
    status: ContactStatus,
    op: Parameters<FleetPort["control"]>[1],
    args: Record<string, unknown>,
  ): Promise<void> {
    if (!status.ctl)
      throw new PortError("no-session", "Mission has no control socket (not launched by holotable)");
    const payload: Record<string, unknown> = { v: 1, op, args, operator: true };
    if (op === "approve") (payload.args as Record<string, unknown>).gate = status.gate?.id ?? null;
    const reply = await ctl(status.ctl.socket, payload, CONTROL_TIMEOUT_MS);
    if (reply.ok === true) return;
    throw new PortError("bad-response", `Mission returned a malformed reply for ${op}`);
  }

  /** The read side of plan review: no operator flag, `no-plan` maps to null. */
  async function readPlan(status: ContactStatus): Promise<{ text: string; path: string; revision: string } | null> {
    if (!status.ctl)
      throw new PortError("no-session", "Mission has no control socket (not launched by holotable)");
    try {
      const reply = await ctl(status.ctl.socket, { v: 1, op: "plan", args: {} }, CONTROL_TIMEOUT_MS);
      const plan = reply.plan;
      if (
        reply.ok !== true ||
        !isRecord(plan) ||
        typeof plan.text !== "string" ||
        typeof plan.path !== "string" ||
        typeof plan.revision !== "string"
      )
        throw new PortError("bad-response", "Mission returned a malformed plan");
      return { text: plan.text, path: plan.path, revision: plan.revision };
    } catch (error) {
      if (error instanceof PortError && error.code === "no-plan") return null;
      throw error;
    }
  }

  return {
    id: "omp-mission",
    async prepare(i) {
      const overlay = OVERLAYS[i.kind];
      const relay = await options.relay();
      await relay.ready();
      const res = await relay.request("write", {
        // Bare filename lands under ~/.holotable on the mission host.
        path: overlay.file,
        b64: Buffer.from(overlay.text, "utf8").toString("base64"),
        mode: 0o600,
      });
      if (typeof res.path !== "string")
        throw new PortError("host-unprepared", "Mission relay did not return the remote overlay path");
      return { overlay: res.path };
    },
    launch: missionLaunch,
    running,
    read,
    ping,
    control,
    readPlan,
  };
}
