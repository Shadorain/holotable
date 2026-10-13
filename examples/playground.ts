// A playable board: the real server, watcher, launcher, actions and lander, over simulated ports.
// Launch a contact and a fake mission walks plan -> execute -> a Pause gate (Approve it) -> review -> complete.
// Some contacts conflict the first time you Land them, which opens a conflict mission. Nothing touches git, Orca or any CLI.
//
//   bun examples/playground.ts [--port 4747] [--host 0.0.0.0] [--home /tmp/holotable-playground]
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Access, ContactStatus, Operation, Settings, TerminalRef, Tracker } from "../src/core/types.ts";
import { PortError, type Ports, type Run, type TrackerHit, type TrackerPort } from "../src/ports.ts";
import { DEFAULT_SETTINGS, settingsFile } from "../src/settings.ts";
import { readSettings } from "../src/store/settings.ts";
import { createFromSpec } from "../src/commands.ts";
import { addContact } from "../src/contacts.ts";
import { appendEvent, readEvents } from "../src/store/events.ts";
import { mutateOperation, readOperation } from "../src/store/operations.ts";
import { seedDemo } from "./demo.ts";
import { startBoard } from "../src/service.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

// Seconds each stage lasts. Short enough to watch, long enough to see the phase rail move.
const EXECUTE_S = 10;
const REVIEW_S = 8;

interface SimMission {
  id: string;
  ticket: string;
  worktree: string;
  branch: string | null;
  born: number;
  stageStart: number;
  stage: "plan" | "execute" | "gate" | "review" | "complete";
  mode: string;
  gate: string;
  /** Missions launched without --pause never arm a gate: they run to review on their own. */
  noPause: boolean;
  planText: string;
  planRev: number;
  planFeedback: string[];
  /** The session is gone (its pane closed or was reaped); a relaunch revives it. */
  closed: boolean;
  /** A relaunched session attaches the saved mission under resume hold until it is continued. */
  resumeHold: boolean;
  /** Control-socket generation: a new session of the same mission gets a new one. */
  gen: number;
}

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// The Add contact ticket search reads a fixed fake backlog per tracker; a few ids
// (CHR-151/156/157/175) are already contacts, so the dialog can show them as taken.
const LINEAR_BACKLOG: TrackerHit[] = [
  { ticket: "CHR-151", title: "Does ACS data migrate?", state: "Triage", url: null },
  { ticket: "CHR-156", title: "Medical status and payments", state: "In Progress", url: null },
  { ticket: "CHR-157", title: "Office / AD Today", state: "In Progress", url: null },
  { ticket: "CHR-158", title: "Attendance export audit", state: "Backlog", url: null },
  { ticket: "CHR-163", title: "Desk check-in kiosk mode", state: "Todo", url: null },
  { ticket: "CHR-169", title: "Guardian portal invite flow", state: "Backlog", url: null },
  { ticket: "CHR-175", title: "Identity and tenant isolation", state: "In Progress", url: null },
  { ticket: "CHR-183", title: "Billing reconciliation report", state: "Backlog", url: null },
  { ticket: "CHR-184", title: "Stripe webhook retries", state: "Todo", url: null },
  { ticket: "CHR-185", title: "Aftercare follow-up scheduler", state: "Backlog", url: null },
  { ticket: "CHR-186", title: "Incident export to insurer", state: "Triage", url: null },
  { ticket: "CHR-187", title: "Attendance anomaly alerts", state: "Backlog", url: null },
  { ticket: "CHR-188", title: "Roster import dedupe", state: "Todo", url: null },
  { ticket: "CHR-189", title: "Parent messaging digest", state: "Backlog", url: null },
  { ticket: "CHR-190", title: "Cutover runbook rehearsal", state: "Backlog", url: null },
];
const GITHUB_BACKLOG: TrackerHit[] = [
  { ticket: "#101", title: "Race in watcher pass scheduling", state: "open", url: "https://github.example/demo/issues/101" },
  { ticket: "#102", title: "Queue order survives restart", state: "open", url: "https://github.example/demo/issues/102" },
  { ticket: "#104", title: "Notes pad loses trailing newline", state: "open", url: "https://github.example/demo/issues/104" },
  { ticket: "#107", title: "Cap counts reaped terminals", state: "open", url: "https://github.example/demo/issues/107" },
  { ticket: "#110", title: "Plan tab stale after refine", state: "open", url: "https://github.example/demo/issues/110" },
  { ticket: "#112", title: "Land retries leave lock file", state: "open", url: "https://github.example/demo/issues/112" },
  { ticket: "#113", title: "Drafts pane leaks env", state: "closed", url: "https://github.example/demo/issues/113" },
  { ticket: "#116", title: "History pagination drops actors", state: "open", url: "https://github.example/demo/issues/116" },
  { ticket: "#117", title: "Zone rename breaks queue ids", state: "open", url: "https://github.example/demo/issues/117" },
  { ticket: "#121", title: "Board token rotation", state: "open", url: "https://github.example/demo/issues/121" },
  { ticket: "#123", title: "Archive report misses usage", state: "open", url: "https://github.example/demo/issues/123" },
  { ticket: "#126", title: "Duplicate queued events fold", state: "closed", url: "https://github.example/demo/issues/126" },
  { ticket: "#129", title: "Terminal focus steals cursor", state: "open", url: "https://github.example/demo/issues/129" },
  { ticket: "#131", title: "Brief markdown preview", state: "open", url: "https://github.example/demo/issues/131" },
  { ticket: "#134", title: "Settings restart banner", state: "open", url: "https://github.example/demo/issues/134" },
];

function simulate(initial: Map<string, SimMission["stage"]>, lanesRoot: string, dirtyPath: string, homeDir: string) {
  const missions = new Map<string, SimMission>();
  const resolved = new Set<string>();
  /** Panes the simulated frontend lists; a closed pane drops out, so the watcher sees it vanish. */
  const terminals = new Map<string, TerminalRef & { worktree: string }>();
  let counter = 0;
  const now = () => Date.now();

  const born = (worktree: string, branch: string | null): SimMission => {
    const existing = missions.get(worktree);
    if (existing) return existing;
    const name = worktree.split("/").pop() ?? worktree;
    const m: SimMission = {
      id: `sim-${++counter}-${name}`,
      ticket: name,
      worktree,
      branch,
      born: now(),
      stageStart: now(),
      stage: initial.get(worktree) ?? "plan",
      mode: "pause",
      gate: randomBytes(6).toString("hex"),
      noPause: false,
      planText: `# Plan for ${name}\n\n1. Survey the checkout.\n2. Make the change.\n3. Verify it.`,
      planRev: 1,
      planFeedback: [],
      closed: false,
      resumeHold: false,
      gen: counter,
    };
    missions.set(worktree, m);
    return m;
  };
  const advance = (m: SimMission) => {
    if (m.closed || m.resumeHold) return;
    const age = (now() - m.stageStart) / 1000;
    const go = (stage: SimMission["stage"]) => {
      m.stage = stage;
      m.stageStart = now();
    };
    // Native plan approval and Pause gates are separate operator actions.
    // Pause gates are separate: without --pause a mission goes straight from execute to review.
    if (m.stage === "execute" && age > EXECUTE_S) go(m.noPause ? "review" : "gate");
    else if (m.stage === "review" && age > REVIEW_S) go("complete");
  };
  const statusOf = (m: SimMission): ContactStatus => {
    advance(m);
    const step = { plan: 1, execute: 3, gate: 5, review: 6, complete: 7 }[m.stage];
    const hold = m.resumeHold ? "resume" : m.stage === "plan" ? "plan-approval" : m.stage === "gate" ? "gate" : "none";
    const phase = { plan: "plan", execute: "execute", gate: "verify", review: "review", complete: "complete" }[m.stage];
    const next = m.resumeHold
      ? "Session reopened under resume hold: continue it to pick up where it left off"
      : {
          plan: "Review the plan below — edit, refine, or approve it",
          execute: "Workers are running",
          gate: "/mission approve — verification passed, approve to continue",
          review: "Reviewer is reading the diff",
          complete: "Delivered — land it",
        }[m.stage];
    const updatedAt = new Date().toISOString();
    const ageS = Math.max(0, Math.round((now() - m.born) / 1000));
    return {
      schema: 1,
      id: m.id,
      ticket: m.ticket,
      title: m.ticket,
      worktree: m.worktree,
      base: "main",
      phase,
      progress: { step, of: 7 },
      hold,
      gate: m.stage === "gate" && !m.resumeHold ? { kind: "pause", id: m.gate } : null,
      next,
      actions: m.resumeHold ? ["continue"] : m.stage === "plan" ? ["plan-approve"] : m.stage === "gate" ? ["approve", "continue"] : m.stage === "execute" ? ["dispatch"] : [],
      workers: m.resumeHold ? { live: 0, total: 3 } : m.stage === "execute" ? { live: 2, total: 3 } : m.stage === "plan" ? null : { live: 0, total: 3 },
      delivery: m.stage === "complete" ? { url: `https://github.example/demo/pull/${100 + (hash(m.ticket) % 50)}`, branch: m.branch } : null,
      complete: m.stage === "complete",
      revision: updatedAt,
      plan: m.stage === "plan" && !m.resumeHold ? { path: `${m.worktree}/.plan.md`, revision: `rev-${m.planRev}` } : null,
      ctl: { socket: `sim:${m.id}`, generation: m.gen },
      mode: m.mode as ContactStatus["mode"],
      usage: {
        tokens: { input: 4000 + ageS * 137, output: 900 + ageS * 41, cacheRead: 1500 + ageS * 53, cacheWrite: 300 + ageS * 7 },
        costUsd: Math.round((0.04 + ageS * 0.0021) * 1000) / 1000,
        sessions: 1,
      },
      updatedAt,
      verify: null,
    };
  };

  // Per-tracker sim: substring search over the fake backlogs; sample keeps the old shape.
  const trackerFor = (kind: Tracker): TrackerPort => {
    const backlog = kind === "linear" ? LINEAR_BACKLOG : kind === "github" ? GITHUB_BACKLOG : null;
    return {
      id: kind,
      sample: async (ticket) => {
        if (backlog === null) return null;
        const known = backlog.find((h) => h.ticket === ticket);
        return {
          state: known?.state ?? (missions.size ? "In Progress" : "Todo"),
          url: known?.url ?? (kind === "linear" ? `https://linear.example/issue/${ticket}` : `https://github.example/demo/issues/${ticket.slice(1)}`),
        };
      },
      search: async (query, _cwd, limit) => {
        if (backlog === null) return null;
        const needle = query.toLowerCase();
        return backlog.filter((h) => h.ticket.toLowerCase().includes(needle) || h.title.toLowerCase().includes(needle)).slice(0, limit);
      },
    };
  };

  const ports: Omit<Ports, "tracker"> = {
    fleet: {
      id: "omp-mission",
      launch: (i) => ({ argv: ["omp", "--config", i.overlay], env: { OMP_MISSION_AUTOSTART: `/mission ${i.contact.ticket}${i.operation.pause ? " --pause" : ""}` } }),
      read: async ({ worktree }) => (missions.get(worktree)?.closed ? null : statusOf(born(worktree, null))),
      ping: async (s) => s.ctl !== null && [...missions.values()].some((m) => m.id === s.id && !m.closed),
      readPlan: async (s) => {
        const m = [...missions.values()].find((x) => x.id === s.id);
        if (!m || m.closed || m.resumeHold || m.stage !== "plan") return null;
        return { text: m.planText, path: `${m.worktree}/.plan.md`, revision: `rev-${m.planRev}` };
      },
      control: async (s, op, args) => {
        const m = [...missions.values()].find((x) => x.id === s.id);
        if (!m || m.closed) throw new PortError("owner-offline", "mission session is gone");
        if (m.resumeHold && op !== "continue" && op !== "mode") throw new PortError("rejected", "Resume hold: continue first");
        advance(m);
        if (op === "plan-edit") {
          if (m.stage !== "plan") throw new PortError("rejected", "No pending plan to edit");
          if (args.base !== `rev-${m.planRev}`) throw new PortError("stale", "Plan moved on; reload before saving");
          m.planText = String(args.text ?? "");
          m.planRev += 1;
          m.stageStart = now();
        } else if (op === "plan-refine") {
          if (m.stage !== "plan") throw new PortError("rejected", "No pending plan to refine");
          m.planFeedback.push(String(args.message ?? ""));
          m.planText += `\n\n## Feedback\n\n${m.planFeedback.map((f) => `- ${f}`).join("\n")}`;
          m.planRev += 1;
          m.stageStart = now();
        } else if (op === "plan-approve") {
          if (m.stage !== "plan") throw new PortError("rejected", "No pending plan to approve");
          if (args.revision !== `rev-${m.planRev}`) throw new PortError("stale", "Plan moved on; reload before approving");
          m.stage = "execute";
          m.stageStart = now();
        } else if (op === "approve") {
          if (m.stage !== "gate") throw new PortError("rejected", "No Pause gate is armed: nothing to approve");
          if (s.gate?.id !== m.gate) throw new PortError("stale", "That gate was replaced; reload and approve the current one");
          m.stage = "review";
          m.stageStart = now();
        } else if (op === "continue" && m.resumeHold) {
          m.resumeHold = false;
          m.stageStart = now();
        } else if (op === "continue" && m.stage === "gate") {
          throw new PortError("rejected", "Pause gate: use approve");
        } else if (op === "mode") {
          m.mode = String(args.mode);
        }
      },
    },
    frontend: {
      id: "custom",
      ensureRepo: async () => {},
      createWorkspace: async (i) => {
        const worktree = join(lanesRoot, i.name);
        mkdirSync(worktree, { recursive: true });
        return { worktree, branch: `sim/${i.name}` };
      },
      openTerminal: async (i) => {
        const reopened = missions.has(i.worktree);
        const m = born(i.worktree, `sim/${i.worktree.split("/").pop()}`);
        if (reopened) {
          // A new omp session in a worktree that holds a saved mission re-attaches it under resume hold.
          m.closed = false;
          m.resumeHold = true;
          m.id = `sim-${++counter}-${m.ticket}`;
          m.gen = counter;
        }
        m.noPause = !i.env.OMP_MISSION_AUTOSTART?.includes("--pause");
        m.mode = m.noPause ? "force" : "pause";
        const opened = { handle: `sim-term-${++counter}`, incarnationId: `inc-${counter}` };
        terminals.set(opened.handle, { ...opened, worktree: i.worktree });
        if (i.title.startsWith("decide ")) {
          // The decision agent: read the prompt's options, write its JSON answer a few seconds later.
          const ticket = i.title.slice("decide ".length).trim();
          const text = i.argv.slice(1).join(" ");
          const choice = text.match(/recommended: "([^"]+)"/)?.[1] ?? text.match(/Options: "([^"]+)"/)?.[1] ?? "proceed as planned";
          const dir = join(homeDir, "operations", i.worktree.split("/").pop() ?? "", "decisions");
          setTimeout(() => {
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, `${encodeURIComponent(ticket)}.json`),
              `${JSON.stringify({ choice, rationale: "The simulated agent read the ticket and picked the strongest option." }, null, 2)}\n`,
            );
            console.log(`[sim] decision for ${ticket} written`);
          }, 5_000).unref();
        }
        return opened;
      },
      listTerminals: async () => [...terminals.values()].map((t) => ({ ...t, connected: true })),
      // There is no real pane to approve a plan in, so a focus sent for plan approval stands in
      // for picking "Approve and compact context" there. Plain focus never touches the mission.
      focus: async (t, worktree, purpose) => {
        const m = missions.get(worktree);
        if (m) advance(m);
        if (purpose === "plan-approval" && m?.stage === "plan" && !m.resumeHold && !m.closed) {
          m.stage = "execute";
          m.stageStart = now();
          console.log(`[sim] plan approved in pane ${t.handle}`);
        } else console.log(`[sim] focus ${t.handle}`);
      },
      close: async (t, worktree) => {
        terminals.delete(t.handle);
        const m = missions.get(worktree);
        if (m) m.closed = true;
      },
      removeWorkspace: async (i) => rmSync(i.worktree, { recursive: true, force: true }),
    },
    delivery: {
      id: "github-pr",
      probe: async ({ contact, status }) =>
        status.complete || status.delivery
          ? { url: `https://github.example/demo/pull/${100 + (hash(contact.ticket) % 50)}`, state: "open", mergeable: "clean", checks: "pass" }
          : null,
      land: async ({ contact, sourceBranch }) => {
        const fromConflictMission = sourceBranch.includes("conflict");
        // Every third contact conflicts the first time; the conflict mission's branch lands clean.
        if (hash(contact.ticket) % 3 === 0 && !fromConflictMission && !resolved.has(contact.ticket)) {
          resolved.add(contact.ticket);
          return { outcome: "conflict", paths: ["src/schema.ts", "src/routes/index.ts"], deliveredSha: "d".repeat(40), baseSha: "b".repeat(40) };
        }
        return { outcome: "landed", via: "pr" };
      },
    },
  };
  // The lander pins and merges with real git; the simulation answers as git would for a conflicted merge.
  const run: Run = async (command, args, cwd) => {
    // Setup checks mock
    if (command === "omp" && args[0] === "--version") return { stdout: "omp v18.4.4", stderr: "", code: 0 };
    if (command === "omp" && args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
      return { stdout: JSON.stringify({ npm: [{ name: "omp-mission" }] }), stderr: "", code: 0 };
    }
    if (command === "lin" && args[0] === "me" && args[1] === "--json") return { stdout: "{}", stderr: "", code: 0 };
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return { stdout: "", stderr: "", code: 0 };
    if (command === "orca" && args[0] === "--version") return { stdout: "orca 1.0.0", stderr: "", code: 0 };
    if (command === "herdr" && args[0] === "--version") return { stdout: "", stderr: "command not found: herdr", code: 127 };

    if (command === "orca" && args[0] === "repo" && args[1] === "list" && args[2] === "--json") {
      return {
        stdout: JSON.stringify({
          repos: [
            {
              displayName: "Charidel",
              path: join(homeDir, "repos", "charidel"),
              worktreeBaseRef: "origin/v2/backend-rewrite",
              worktreeBasePath: join(homeDir, "lanes", "charidel", ".wt"),
            },
            {
              displayName: "omp-mission",
              path: join(homeDir, "repos", "mission"),
              worktreeBaseRef: "origin/main",
              worktreeBasePath: join(homeDir, "lanes", "mission", ".wt"),
            },
            {
              displayName: "Daedalus lab",
              path: join(homeDir, "repos", "lab"),
              worktreeBaseRef: "origin/main",
              worktreeBasePath: join(homeDir, "lanes", "lab", ".wt"),
            },
          ],
        }),
        stderr: "",
        code: 0,
      };
    }

    if (command === "orca" && args[0] === "repo" && args[1] === "show") {
      const repo = args[args.indexOf("--repo") + 1]?.replace(/^path:/, "") ?? "";
      return { stdout: JSON.stringify({ ok: true, result: { repo: { path: repo, worktreeBasePath: `${repo}/.wt` } } }), stderr: "", code: 0 };
    }

    // Draft panes and the project repo check go through the orca frontend.
    if (command === "orca" && args[0] === "terminal" && args[1] === "create" && args.includes("--json")) {
      const worktree = args[args.indexOf("--worktree") + 1]?.replace(/^path:/, "") ?? "";
      const title = args[args.indexOf("--title") + 1] ?? "pane";
      const t = born(worktree, null);
      const term = { handle: `sim-${t.id}`, incarnationId: t.id };
      terminals.set(term.handle, { ...term, worktree });
      return { stdout: JSON.stringify({ ok: true, result: { terminal: term } }), stderr: "", code: 0 };
    }
    if (command === "orca" && args[0] === "terminal" && args[1] === "list" && args[2] === "--json") {
      const rows = [...terminals.values()]
        .filter((t) => !missions.get(t.worktree)?.closed)
        .map((t) => ({ handle: t.handle, incarnationId: t.incarnationId, title: "pane", worktree: { path: t.worktree } }));
      return { stdout: JSON.stringify({ ok: true, result: { terminals: rows } }), stderr: "", code: 0 };
    }
    if (command === "orca" && args[0] === "repo" && args[1] === "add") {
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: "", code: 0 };
    }

    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        const match = cwd.match(/^(.+?\/repos\/[^/]+)/);
        const top = match ? match[1] : cwd;
        return { stdout: `${top}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "symbolic-ref") {
        const ref = cwd.includes("charidel") ? "origin/v2/backend-rewrite" : "origin/main";
        return { stdout: `${ref}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "branch" && args[1] === "--show-current") {
        const b = cwd.includes("charidel") ? "v2/backend-rewrite" : "main";
        return { stdout: `${b}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        const name = cwd.split("/").pop() ?? "demo";
        return { stdout: `https://github.com/daedalus-lab/${name}.git\n`, stderr: "", code: 0 };
      }
    }

    if (args.includes("--diff-filter=U")) return { stdout: "src/schema.ts\nsrc/routes/index.ts\n", stderr: "", code: 0 };
    // One seeded lane is deliberately dirty so abort-preview shows the warning.
    return { stdout: command === "git" && cwd === dirtyPath ? " M src/app.ts\n" : "", stderr: "", code: 0 };
  };
  /** A pane that closed under a live session: gone from the frontend's list, session gone with it. */
  const closePane = (worktree: string) => {
    born(worktree, null).closed = true;
  };
  const seedTerminal = (t: TerminalRef, worktree: string) => terminals.set(t.handle, { ...t, worktree });
  return { ports, run, trackerFor, closePane, seedTerminal };
}

/** Wipe the demo data but keep the operator's settings.json, so theme, cap and polling survive restarts. */
function resetHome(home: string, recreate: boolean): void {
  const file = settingsFile(home);
  const kept = existsSync(file) ? readFileSync(file) : null;
  rmSync(home, { recursive: true, force: true });
  if (kept === null && !recreate) return;
  mkdirSync(home, { recursive: true });
  if (kept !== null) writeFileSync(file, kept, { mode: 0o600 });
}

async function main(): Promise<void> {
  const home = arg("home", "/tmp/holotable-playground");
  resetHome(home, true);
  const ids = await seedDemo(home);
  for (const repoName of ["charidel", "mission", "lab", "autopilot", "scratch"]) {
    mkdirSync(join(home, "repos", repoName), { recursive: true });
  }
  // Make the second operation fully playable; the third stays all-none to show the no-stack board.
  await mutateOperation(home, "mission", (op: Operation) => ({ ...op, fleet: "omp-mission", frontend: "custom", delivery: "local-merge" }));
  // One pane in `mission` closed under a running session: not reaped, not complete, and the sim's frontend no
  // longer lists its terminal. Relaunch brings it back; so does switching `recover` on for the operation.
  const closedWorktree = join(home, "lanes", "mission", "status");
  const closedTerminal = { handle: "t-status", incarnationId: "i-status" };
  await mutateOperation(home, "mission", (op: Operation) => ({
    ...op,
    contacts: op.contacts.map((c) =>
      c.ticket === "status" ? { ...c, lane: { worktree: closedWorktree, branch: "holotable/status", frontend: "custom" as const, terminal: closedTerminal } } : c,
    ),
  }));
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  await appendEvent(home, "mission", { v: 1, at: ago(26), kind: "launched", contact: "status", worktree: closedWorktree, frontend: "custom", terminal: closedTerminal });
  await appendEvent(home, "mission", { v: 1, at: ago(26), kind: "socket-up", contact: "status", generation: 1 });
  await appendEvent(home, "mission", { v: 1, at: ago(25), kind: "phase", contact: "status", from: null, to: "execute" });
  await appendEvent(home, "mission", { v: 1, at: ago(4), kind: "socket-down", contact: "status" });
  const seededAt = new Date();
  await addContact(home, seededAt, "charidel", { ticket: "CHR-180", zone: "plat", title: "Audit log export" });
  await addContact(home, seededAt, "charidel", { ticket: "CHR-181", zone: "plat", title: "Audit log viewer", blockedBy: ["CHR-180"] });
  await addContact(home, seededAt, "charidel", { ticket: "CHR-182", zone: "cut", kind: "audit", title: "Cutover dry-run audit", source: "model" });

  // Auto mode: the board lands finished missions and launches the next one itself.
  // dry-* names are chosen so none hash into the simulator's conflict bucket.
  await createFromSpec(home, seededAt, {
    id: "autopilot",
    repo: join(home, "repos", "autopilot"),
    base: "main",
    name: "Autopilot",
    pause: false,
    tracker: "none",
    fleet: "omp-mission",
    frontend: "custom",
    delivery: "local-merge",
    recover: true,
    seed: JSON.stringify({
      brief: "# Autopilot\n\nAuto mode launches the queue and lands finished missions. Approve each plan from the contact's Plan tab, or opt in to Approve plans. Pause gates still wait for you.",
      zones: [{ id: "pipe", label: "PIPELINE" }],
      contacts: [
        { ticket: "dry-a", title: "Backfill stats", zone: "pipe", kind: "implement" },
        { ticket: "dry-b", title: "Reindex cards", zone: "pipe", kind: "implement", blockedBy: ["dry-a"] },
        { ticket: "row-c", title: "Publish digest", zone: "pipe", kind: "implement", blockedBy: ["dry-b"] },
      ],
      notes: "## Autopilot\n\n- [ ] Queue drained\n- [x] Auto mode wired",
    }),
  });
  await mutateOperation(home, "autopilot", (op) => ({ ...op, auto: { enabled: true, launch: true, land: true, maxLive: 2, plans: false, decide: false } }));

  // Seeded missions resume where their events left them instead of all restarting at plan.
  const initial = new Map<string, SimMission["stage"]>();
  const seededTerminals: Array<{ terminal: TerminalRef; worktree: string }> = [];
  const STAGE: Record<string, SimMission["stage"]> = { isolate: "plan", plan: "plan", execute: "execute", verify: "gate", review: "review", complete: "complete" };
  for (const id of ids) {
    const op = await readOperation(home, id);
    const events = await readEvents(home, id);
    for (const c of op.contacts) {
      if (!c.lane) continue;
      const mine = events.filter((e) => "contact" in e && e.contact === c.ticket);
      const phase = mine.filter((e) => e.kind === "phase").at(-1);
      const delivered = mine.some((e) => e.kind === "land-attempt" || e.kind === "landed");
      initial.set(c.lane.worktree, delivered ? "complete" : phase?.kind === "phase" ? (STAGE[phase.to] ?? "execute") : "plan");
      // Seeded lanes exist on disk so abort-preview and wind-down can see them.
      mkdirSync(c.lane.worktree, { recursive: true });
      // The frontend lists every seeded pane except the one that closed.
      if (c.lane.terminal && c.lane.worktree !== closedWorktree) seededTerminals.push({ terminal: c.lane.terminal, worktree: c.lane.worktree });
    }
  }
  const dirtyPath = join(home, "lanes", "charidel", "chr-167");
  const sim = simulate(initial, join(home, "lanes"), dirtyPath, home);
  for (const { terminal, worktree } of seededTerminals) sim.seedTerminal(terminal, worktree);
  // Usage attribution (`GET /api/usage`) is real but sim lanes run no processes, so the
  // operation and all-operations rows read zero; the machine row shows the real host.
  sim.closePane(closedWorktree);
  const { ports, run, trackerFor } = sim;
  // The operator's saved settings (the drawer writes settings.json) win over the playground's fast defaults;
  // the bind address always comes from the command line.
  const accessArg = arg("access", "");
  const hostArg = arg("host", "");
  let access: Access = "tailscale";
  if (accessArg === "local" || accessArg === "tailscale" || accessArg === "network") {
    access = accessArg;
  } else if (hostArg) {
    access = hostArg === "127.0.0.1" || hostArg === "localhost" ? "local" : "network";
  }
  const bind = { access, port: Number(arg("port", "4747")) };
  const settings = async (): Promise<Settings> =>
    existsSync(settingsFile(home)) ? { ...(await readSettings(home)), ...bind } : { ...DEFAULT_SETTINGS, ...bind, cap: 8, pollMs: 2_000, sampleMs: 2_000 };
  const board = await startBoard({ home, settings, portsFor: (op) => ({ ...ports, tracker: trackerFor(op.tracker) }), run });

  // Created after the start-up migration (which groups the seeded repos into projects):
  // the board always has one standalone, project-less operation to show.
  mkdirSync(join(home, "repos", "scratch"), { recursive: true });
  await createFromSpec(home, new Date(), {
    id: "scratch",
    repo: join(home, "repos", "scratch"),
    base: "main",
    name: "Scratch (no project)",
    tracker: "none",
    fleet: "none",
    frontend: "herdr",
    delivery: "none",
    seed: JSON.stringify({ zones: [{ id: "misc", label: "MISC" }], contacts: [], notes: "## Scratch\n\n- [ ] Try the notes tab" }),
  });

  const hash_ = new URL(board.url).hash;
  const port = new URL(board.url).port;
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((e) => e.family === "IPv4" && !e.internal)
    .map((e) => e.address);
  console.log(`operations: ${ids.join(", ")}`);
  console.log("PLAYGROUND_URLS");
  for (const u of board.urls.length > 0 ? board.urls : [board.url]) console.log(`  ${u}`);
  const { promise: sigint, resolve: stop } = Promise.withResolvers<void>();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await sigint;
  await board.close();
  resetHome(home, false);
}

await main();
