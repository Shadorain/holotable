import { mkdir } from "node:fs/promises";
import type { ActionRequest } from "../board.ts";
import type { Contact, ControlOp, OperatorOp } from "../core/types.ts";
import { askAnswers } from "../core/ask.ts";
import { PortError } from "../ports.ts";
import { foldEvents } from "../core/fold.ts";
import { contactOf } from "../core/projection.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { readBrief } from "../store/brief.ts";
import { decisionPrompt, decisionSessionsDir, readDecisionPane, validateDecision, writeDecisionPane } from "../store/decisions.ts";
import { readNotes } from "../store/notes.ts";
import { readOperation } from "../store/operations.ts";
import { loadProjection } from "../snapshot.ts";
import { cleanupAbandonedConflict, cleanupAfterLand } from "./cleanup.ts";
import { ActionError } from "./errors.ts";
import { landContact, type LanderDeps } from "./lander.ts";
import { launchContact, relaunchContact } from "./launcher.ts";
import { autoChecksSinceBase, MAX_AUTO_CHECKS, reviewsRequested } from "./auto.ts";
import { offered } from "./offer.ts";

/** Port failures an operator can act on, or wait out, are conflicts (409); anything else is an upstream failure (502). */
const CONFLICT_CODES = ["owner-offline", "stale", "busy", "rejected", "no-session", "terminal-missing", "checks-pending", "branch-updated"];

function asActionError(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  if (error instanceof PortError) return new ActionError(CONFLICT_CODES.includes(error.code) ? 409 : 502, error.code, error.message);
  return new ActionError(500, "internal", error instanceof Error ? error.message : String(error));
}

/** An optional `model` override: a string, null for the default, or absent. */
function modelArg(args: Record<string, unknown>): string | null | undefined {
  const model = args.model;
  if (model === undefined || model === null || typeof model === "string") return model;
  throw new ActionError(400, "bad-request", "model must be a string or null");
}

/**
 * The single dispatch for operator actions. The only caller of launcher, frontend close and (from slice 7)
 * fleet control. Every action except focus leaves an `operator` event, success or failure.
 */
export function createActionRunner(deps: LanderDeps): (req: ActionRequest) => Promise<void> {
  // A launch can take minutes; a second click must not create a second worktree. Shared with the
  // ender/launcher when `deps.inFlight` is set, so they can see running actions.
  const inFlight = deps.inFlight ?? new Map<string, string>();
  /** Marking done is what unblocks dependents: only the `landed` event does, never a mission's own `complete`. */
  async function done(opId: string, ticket: string, args: Record<string, unknown>): Promise<void> {
    const { settings, view, operation, contact } = await offered(deps, opId, ticket, "done", `${ticket} cannot be marked done in its current state`);
    // Done is bookkeeping that unblocks dependents and removes the worktree. Code-carrying contacts must really
    // be in the base first; a decision or a conflict mission lands through another contact's merge.
    const branch = contact?.lane?.branch;
    if (contact && branch && contact.kind !== "decision" && contact.kind !== "conflict") {
      const delivery = deps.portsFor(operation, settings).delivery;
      const verdict = await delivery.verifyMerged({ operation, contact, branch, url: view.delivery?.url });
      if (!verdict.merged) {
        // An audit that committed code delivers no PR; without one, Mark done could only refuse forever.
        // Open the review it never opened, and Land takes over once the probe sees it.
        if (contact.kind === "audit" && delivery.publish && !view.delivery?.url && !deps.extras(opId).probes?.[ticket]) {
          const { url } = await delivery.publish({ operation, contact, branch });
          throw new ActionError(409, "pr-opened", `${ticket}'s commits are not in ${operation.base}; opened ${url} for them. Land it once its checks pass`);
        }
        throw new ActionError(409, "not-merged", `${ticket} is not merged into ${operation.base}: ${verdict.reason}`);
      }
    }
    const at = deps.now().toISOString();
    if (contact?.kind === "decision") {
      const decision = decideArgs("done", contact, args);
      await appendEvent(deps.home, opId, { v: 1, at, kind: "decided", contact: ticket, by: "operator", ...decision });
    }
    if(contact?.lane)await deps.captureMetrics?.(operation,contact);
    await appendEvent(deps.home,opId,{v:1,at:deps.now().toISOString(),kind:"landed",contact:ticket,via:"manual"});
    if (contact?.lane) await cleanupAfterLand(deps, opId, ticket);
  }

  /** The `choice`/`rationale` contract shared by done and redecide on a decision contact. */
  function decideArgs(op: "done" | "redecide", contact: Contact, args: Record<string, unknown>): { choice: string; rationale?: string } {
    const required = op === "redecide" || contact.options !== undefined;
    let choice = args.choice;
    if (choice === undefined || choice === null) {
      if (required)
        throw new ActionError(400, "bad-request", `${op} on ${contact.ticket} needs {choice: string}`);
      choice = "decided";
    }
    if (typeof choice !== "string" || choice.length === 0)
      throw new ActionError(400, "bad-request", "choice must be a non-empty string");
    try {
      return validateDecision({ choice, rationale: args.rationale }, contact);
    } catch (error) {
      throw new ActionError(400, "bad-request", error instanceof Error ? error.message : String(error));
    }
  }

  /** A landed decision can be overturned: a new `decided` replaces it, dependents stay unblocked. */
  async function redecide(opId: string, ticket: string, args: Record<string, unknown>): Promise<void> {
    const { contact } = await offered(deps, opId, ticket, "redecide", `${ticket} cannot be redecided in its current state`);
    if (!contact) throw new ActionError(404, "not-found", `No contact ${ticket} in ${opId}`);
    const decision = decideArgs("redecide", contact, args);
    await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "decided", contact: ticket, by: "operator", ...decision });
  }

  /**
   * Open a lane-less agent pane that reads the repo and writes its answer to
   * decisions/<ticket>.json; the watcher lands it (or records why it could not).
   */
  async function decideAgent(opId: string, ticket: string, modelOverride?: string | null): Promise<void> {
    const { settings, projection, operation, contact } = await offered(deps, opId, ticket, "decide-agent", `${ticket} cannot ask an agent in its current state`);
    if (!contact) throw new ActionError(404, "not-found", `No contact ${ticket} in ${opId}`);
    if (await readDecisionPane(deps.home, opId, ticket))
      throw new ActionError(409, "refused", `${ticket} is already asking an agent`);
    const ports = deps.portsFor(operation, settings);
    const [brief, notes] = await Promise.all([readBrief(deps.home, opId), readNotes(deps.home, opId)]);
    const prompt = decisionPrompt({
      home: deps.home,
      opId,
      contact,
      brief: brief.brief,
      notes: notes.text === "" ? null : notes.text,
      decided: projection.contacts
        .filter((c) => c.ticket !== ticket && c.decision !== null)
        .map((c) => ({ ticket: c.ticket, decision: c.decision as NonNullable<typeof c.decision> })),
    });
    const selectedModel = modelOverride !== undefined
      ? modelOverride
      : (settings.ai.decision ?? settings.ai.model);
    const argv = ["omp"];
    if (selectedModel) argv.push("--model", selectedModel);
    if (settings.ai.thinking) argv.push("--thinking", settings.ai.thinking);
    // Pin the pane's transcript dir inside the operation so the watcher can attribute its spend.
    const sessionsDir = decisionSessionsDir(deps.home, opId, ticket);
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    argv.push("--session-dir", sessionsDir);
    argv.push(prompt);
    const terminal = await ports.frontend.openTerminal({
      worktree: operation.integration,
      title: `decide ${ticket}`,
      argv,
      env: { OMP_HOLOTABLE_CHILD: "1" },
    });
    await writeDecisionPane(deps.home, opId, ticket, { terminal, startedAt: deps.now().toISOString() });
  }

  async function reap(opId: string, ticket: string): Promise<void> {
    const operation = await readOperation(deps.home, opId);
    const contact = contactOf(operation, ticket);
    const lane = contact?.lane;
    if (!lane?.terminal) throw new ActionError(409, "refused", "no terminal recorded");
    const derived = foldEvents(await readEvents(deps.home, opId));
    if (derived.contacts[ticket]?.reaped) throw new ActionError(409, "refused", "already reaped");
    const settings = await deps.settings();
    // A completed conflict mission's branch is the target's pending resolution; only an unfinished one is abandoned.
    let abandoning = false;
    if (contact?.kind === "conflict") {
      const state = contactOf(await loadProjection(deps.home, opId, settings, deps.now().getTime(), deps.extras(opId)), ticket)?.state;
      abandoning = state !== "complete" && state !== "landed";
    }
    await deps.captureMetrics?.(operation,contact!);
    try {
      await deps.portsFor(operation, settings).frontend.close(lane.terminal, lane.worktree);
    } catch (error) {
      // A terminal the frontend already forgot is gone: reaping is still the right record.
      if (!(error instanceof PortError && error.code === "terminal-missing")) throw error;
    }
    await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "reaped", contact: ticket });
    if (abandoning) await cleanupAbandonedConflict(deps, opId, ticket);
  }

  /** Mutations go through the owning session's socket with a freshly read status; this process never attaches. */
  async function fleetOp(opId: string, ticket: string, op: ControlOp, args: Record<string, unknown>, recovering = false, authorizingRepair = false, requestingReview = false): Promise<void> {
    const operation = await readOperation(deps.home, opId);
    if (recovering && !operation.recover)
      throw new ActionError(409, "refused", "Recovery is disabled for this operation");
    if (authorizingRepair) {
      if (!operation.auto?.enabled || !operation.auto.repairs)
        throw new ActionError(409, "refused", "Automatic extra repairs are disabled");
      const events = await readEvents(deps.home, opId);
      if (events.some(event => event.kind === "operator" && event.contact === ticket && event.op === "review" &&
          event.by === "auto" && event.args?.repairBudgetOnly === true))
        throw new ActionError(409, "refused", "Automatic extra repair cycle already used");
    }
    if (requestingReview) {
      if (!operation.auto?.enabled || !operation.auto.reviews)
        throw new ActionError(409, "refused", "Automatic review requests are disabled");
      if (reviewsRequested(await readEvents(deps.home, opId), ticket))
        throw new ActionError(409, "refused", "Automatic review request already sent; the mission's mode is yours");
    }
    const lane = contactOf(operation, ticket)?.lane;
    if (!lane) throw new ActionError(409, "refused", `${ticket} has no lane`);
    const fleet = deps.portsFor(operation, await deps.settings()).fleet;
    const status = await fleet.read({ worktree: lane.worktree });
    // The pane may be alive while its mission is gone; only a relaunch brings a fresh session back.
    if (!status) throw new ActionError(409, "owner-offline", `No mission status for ${ticket}; relaunch a dead pane instead`);
    if (recovering && (status.complete || status.hold !== "resume" || status.verify === "failed" || !status.actions.includes("continue")))
      throw new ActionError(409, "refused", "Automatic Continue requires a resumable mission without quota or failed verification");
    if (authorizingRepair && (status.problem?.source !== "repair-budget" || status.problem.kind !== "error" ||
        status.verify !== "passed" || status.mode === "pause" || status.hold !== "blocked" || !status.actions.includes("review")))
      throw new ActionError(409, "refused", "Mission no longer offers a confirmed repair-budget hold");
    if (requestingReview && (status.mode !== "auto" || status.complete || !status.actions.includes("mode")))
      throw new ActionError(409, "refused", "Mission is no longer in Auto mode outside plan review");
    if (op === "retry-model" && !status.actions.includes(op))
      throw new ActionError(409, "refused", "Mission no longer offers model recovery; refresh its state or reload an older mission pane");
    if (op === "check" && !status.actions.includes(op))
      throw new ActionError(409, "refused", "Mission does not offer a PR check now; it needs a delivered PR, or its pane predates Check");
    await fleet.control(status, op, args);
  }

  /** Rechecked at send time: the operation's auto landing intent and the per-contact attempt bound. */
  async function assertAutoCheck(opId: string, ticket: string): Promise<void> {
    const operation = await readOperation(deps.home, opId);
    if (!operation.auto?.enabled || !operation.auto.land) throw new ActionError(409, "refused", "Automatic landing is disabled");
    const attempts = autoChecksSinceBase(await readEvents(deps.home, opId), ticket);
    if (attempts.length >= MAX_AUTO_CHECKS) throw new ActionError(409, "refused", `Automatic PR checks already used (${MAX_AUTO_CHECKS}) since the base last moved`);
  }

  /** Same legality the board enforces: the Relaunch button exists and is enabled on a fresh projection. */
  async function relaunch(opId: string, ticket: string, recovering: boolean): Promise<void> {
    await offered(deps, opId, ticket, "relaunch", `${ticket} cannot be relaunched in its current state`);
    await relaunchContact(deps, opId, ticket, recovering);
  }

  async function focus(opId: string, ticket: string, purpose?: string): Promise<void> {
    const operation = await readOperation(deps.home, opId);
    const lane = contactOf(operation, ticket)?.lane;
    if (!lane?.terminal) throw new ActionError(409, "refused", "no terminal recorded");
    await deps.portsFor(operation, await deps.settings()).frontend.focus(lane.terminal, lane.worktree, purpose);
  }

  /** Answer the mission's open `ask` through its socket; the mission settles the pane's dialog as if answered there. */
  async function answer(opId: string, ticket: string, id: string, raw: unknown): Promise<void> {
    const operation = await readOperation(deps.home, opId);
    const lane = contactOf(operation, ticket)?.lane;
    if (!lane) throw new ActionError(409, "refused", `${ticket} has no lane`);
    const fleet = deps.portsFor(operation, await deps.settings()).fleet;
    const status = await fleet.read({ worktree: lane.worktree });
    if (status?.hold !== "question" || !status.ask || !status.actions.includes("answer"))
      throw new ActionError(409, "stale", `${ticket} is no longer asking a question it can take from the board`);
    if (status.ask.id !== id) throw new ActionError(409, "stale", `${ticket} is asking a different question now; read it again`);
    const answers = askAnswers(status.ask, raw);
    if (typeof answers === "string") throw new ActionError(400, "bad-request", answers);
    await fleet.control(status, "answer", { id, answers });
  }

  return async (req) => {
    let run: () => Promise<void>;
    switch (req.action) {
      case "focus": {
        const purpose = req.args.purpose;
        if (purpose !== undefined && purpose !== "plan-approval")
          throw new ActionError(400, "bad-request", `Unknown focus purpose "${String(purpose)}"`);
        // Looking is not an operator decision: no event, no in-flight lock.
        return focus(req.op, req.contact, purpose).catch((error) => {
          throw asActionError(error);
        });
      }
      case "answer": {
        // Answering is the operator's call; automation never answers a mission's question.
        if (req.by !== undefined) throw new ActionError(403, "refused", "Only the operator answers a mission's question");
        if (typeof req.args.id !== "string" || !req.args.id)
          throw new ActionError(400, "bad-request", "answer needs {id: string, answers: [{option} | {options} | {text}]}");
        const id = req.args.id;
        run = () => answer(req.op, req.contact, id, req.args.answers);
        break;
      }
      case "approve":
      case "continue":
      case "dispatch":
        run = () => fleetOp(req.op, req.contact, req.action as OperatorOp, {}, req.by === "recover" && req.action === "continue");
        break;
      case "review":
        if (req.by !== undefined && (req.by !== "auto" || req.args.repairBudgetOnly !== true))
          throw new ActionError(403, "refused", "Automatic Review requires an opted-in repair-budget authorization");
        run = () => fleetOp(req.op, req.contact, "review", req.args.repairBudgetOnly === true ? { repairBudgetOnly: true } : {}, false, req.by === "auto");
        break;
      case "check":
        // Auto mode may ask a finished mission to fix its own failing PR checks, bounded; Recovery never does.
        if (req.by !== undefined && req.by !== "auto") throw new ActionError(403, "refused", "Checking a PR requires an operator or auto mode");
        run = async () => {
          if (req.by === "auto") await assertAutoCheck(req.op, req.contact);
          await fleetOp(req.op, req.contact, "check", {});
        };
        break;
      case "retry-model":
        if (req.by !== undefined) throw new ActionError(403, "refused", "Model recovery requires an operator");
        if (typeof req.args.model !== "string" || !req.args.model.trim() || req.args.model.length > 1000)
          throw new ActionError(400, "bad-request", "Choose a concrete recovery model");
        run = () => fleetOp(req.op, req.contact, "retry-model", { model: req.args.model });
        break;
      case "resend":
      case "release":
        run = () => fleetOp(req.op, req.contact, req.action as OperatorOp, {
          ...(typeof req.args.beadId === "string" ? { beadId: req.args.beadId } : {}),
          ...(typeof req.args.detail === "string" ? { detail: req.args.detail } : {}),
          ...(req.action === "resend" && Array.isArray(req.args.files) && req.args.files.every((f) => typeof f === "string") ? { files: req.args.files } : {}),
        });
        break;
      case "plan-approve":
        run = () => fleetOp(req.op, req.contact, "plan-approve", req.args.revision ? { revision: req.args.revision } : {});
        break;
      case "relaunch":
        run = () => relaunch(req.op, req.contact, req.by === "recover");
        break;
      case "mode": {
        const mode = req.args.mode;
        if (mode !== "auto" && mode !== "pause" && mode !== "force")
          throw new ActionError(400, "bad-request", "mode must be auto, pause or force");
        if (req.by !== undefined && (req.by !== "auto" || mode !== "force"))
          throw new ActionError(403, "refused", "Automatic mode changes only request reviews (Auto to Force)");
        run = () => fleetOp(req.op, req.contact, "mode", { mode }, false, false, req.by === "auto");
        break;
      }
      case "plan-save": {
        const text = req.args.text;
        if (typeof text !== "string") throw new ActionError(400, "bad-request", "plan-save needs {text: string}");
        run = () => fleetOp(req.op, req.contact, "plan-edit", { text, base: req.args.revision });
        break;
      }
      case "plan-refine": {
        const message = req.args.message;
        if (typeof message !== "string" || message.length === 0 || message.length > 8000)
          throw new ActionError(400, "bad-request", "plan-refine needs {message: string} (1..8000 chars)");
        run = () => fleetOp(req.op, req.contact, "plan-refine", { message });
        break;
      }
      case "done":
        run = () => done(req.op, req.contact, req.args);
        break;
      case "redecide":
        run = () => redecide(req.op, req.contact, req.args);
        break;
      case "decide-agent": {
        const model = modelArg(req.args);
        run = () => decideAgent(req.op, req.contact, model);
        break;
      }
      case "land":
        run = () => landContact(deps, req.op, req.contact);
        break;
      case "land-anyway":
        if (req.by !== undefined) throw new ActionError(403, "refused", "Landing past failing checks requires an operator");
        run = () => landContact(deps, req.op, req.contact, { anyway: true });
        break;
      case "launch": {
        const model = modelArg(req.args);
        run = () =>
          launchContact(deps, req.op, req.contact, {
            ...(req.args.conflictPaths ? { conflictPaths: req.args.conflictPaths as string[] } : {}),
            ...(model !== undefined ? { model } : {}),
          });
        break;
      }
      case "reap":
        run = () => reap(req.op, req.contact);
        break;
      default:
        throw new ActionError(404, "unknown-action", `Unknown action "${req.action}"`);
    }
    const key = `${req.op}/${req.contact}`;
    if (inFlight.has(key)) throw new ActionError(409, "busy", `An action is already running for ${req.contact}`);
    inFlight.set(key, req.action);
    try {
      await run();
      await appendEvent(deps.home, req.op, { v: 1, at: deps.now().toISOString(), kind: "operator", contact: req.contact, op: req.action, ok: true, ...(req.by !== undefined ? { by: req.by } : {}), ...(Object.keys(req.args).length > 0 ? { args: req.args } : {}) });
    } catch (error) {
      const failure = asActionError(error);
      await appendEvent(deps.home, req.op, {
        v: 1,
        at: deps.now().toISOString(),
        kind: "operator",
        contact: req.contact,
        op: req.action,
        ok: false,
        error: `${failure.code}: ${failure.message}`,
        ...(req.by !== undefined ? { by: req.by } : {}),
        ...(Object.keys(req.args).length > 0 ? { args: req.args } : {}),
      });
      throw failure;
    } finally {
      inFlight.delete(key);
    }
  };
}
