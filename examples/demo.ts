// Demo data: three operations modeled on real campaigns. `examples/playground.ts`
// serves them over simulated ports (`bun run demo`); tests seed from it too.
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Contact, Event, Operation } from "../src/core/types.ts";
import { appendEvent } from "../src/store/events.ts";
import { readNotes, writeNotes } from "../src/store/notes.ts";
import { createOperation } from "../src/store/operations.ts";
import { operationDir } from "../src/paths.ts";


interface SeedContact extends Omit<Contact, "lane"> {
  lane?: Contact["lane"];
}

function makeOp(home: string, init: {
  id: string; name: string; base: string;
  tracker: Operation["tracker"]; fleet: Operation["fleet"];
  frontend: Operation["frontend"]; delivery: Operation["delivery"];
  zones: Operation["zones"]; contacts: SeedContact[];
}): Operation {
  return {
    v: 1,
    id: init.id,
    name: init.name,
    repo: join(home, "repos", init.id),
    integration: join(home, "repos", init.id),
    base: init.base,
    pause: true,
    tracker: init.tracker,
    fleet: init.fleet,
    frontend: init.frontend,
    delivery: init.delivery,
    zones: init.zones,
    contacts: init.contacts.map((c) => ({ ...c, lane: c.lane ?? null })),
    project: null,
    recover: false,
    createdAt: new Date().toISOString(),
  };
}

export async function seedDemo(home: string): Promise<string[]> {
  // Deterministic timeline: start two hours ago, one minute per event.
  let t = Date.now() - 2 * 60 * 60 * 1000;
  const at = () => new Date((t += 60_000)).toISOString();
  const ev = (contact: string, kind: Event["kind"], extra: Record<string, unknown> = {}): Event =>
    ({ v: 1, at: at(), kind, contact, ...(kind === "queued" ? { source: "seed" } : {}), ...extra }) as Event;
  const laneAt = (opId: string, ticket: string): NonNullable<Contact["lane"]> => ({
    worktree: join(home, "lanes", opId, ticket.toLowerCase()),
    branch: `holotable/${ticket.toLowerCase()}`,
    frontend: "orca",
    terminal: { handle: `t-${ticket.toLowerCase()}`, incarnationId: `i-${ticket.toLowerCase()}` },
  });

  // ---- op 1: charidel (linear + orca + github-pr), 4 zones, 7 contacts ----
  const charidel = makeOp(home, {
    id: "charidel", name: "Charidel V2", base: "v2/backend-rewrite",
    tracker: "linear", fleet: "omp-mission", frontend: "orca", delivery: "github-pr",
    zones: [
      { id: "ath", label: "ATHLETICS" },
      { id: "aft", label: "AFTERCARE" },
      { id: "plat", label: "PLATFORM" },
      { id: "cut", label: "CUTOVER" },
    ],
    contacts: [
      { ticket: "CHR-157", title: "Office / AD Today", zone: "ath", kind: "implement", blockedBy: [], conflictOf: null, lane: laneAt("charidel", "CHR-157") },
      { ticket: "CHR-157-CONFLICT-1", title: "Resolve markers for CHR-157", zone: "ath", kind: "conflict", blockedBy: [], conflictOf: "CHR-157", lane: laneAt("charidel", "CHR-157-CONFLICT-1") },
      { ticket: "CHR-156", title: "Medical status and payments", zone: "ath", kind: "implement", blockedBy: [], conflictOf: null },
      { ticket: "CHR-167", title: "Reconciliation endpoints", zone: "aft", kind: "implement", blockedBy: [], conflictOf: null, lane: laneAt("charidel", "CHR-167") },
      { ticket: "CHR-168", title: "Reconciliation desk", zone: "aft", kind: "implement", blockedBy: ["CHR-167"], conflictOf: null },
      { ticket: "CHR-175", title: "Identity and tenant isolation", zone: "plat", kind: "implement", blockedBy: [], conflictOf: null, lane: laneAt("charidel", "CHR-175") },
      { ticket: "CHR-153", title: "Workspace navigation", zone: "plat", kind: "implement", blockedBy: [], conflictOf: null, lane: laneAt("charidel", "CHR-153") },
      { ticket: "CHR-151", title: "Does ACS data migrate?", zone: "cut", kind: "decision", blockedBy: [], conflictOf: null, options: ["Migrate ACS data", "Start fresh"], recommended: "Migrate ACS data" },
      { ticket: "CHR-163", title: "Desk check-in kiosk mode", zone: "cut", kind: "decision", blockedBy: [], conflictOf: null },
    ],
  });
  await createOperation(home, charidel);
  // charidel keeps the legacy `workflow` key on disk: the first read migrates it to notes.md.
  const opFile = join(operationDir(home, "charidel"), "operation.json");
  const legacy = { ...(JSON.parse(await readFile(opFile, "utf8")) as Record<string, unknown>), workflow: [
    { id: "schema", label: "Schema migrated" },
    { id: "seed", label: "Seed data verified" },
    { id: "billing", label: "Billing reconciled" },
    { id: "cutover", label: "Cutover rehearsed" },
  ] };
  await writeFile(opFile, `${JSON.stringify(legacy, null, 2)}\n`);
  for (const e of [
    ev("CHR-157", "queued"), ev("CHR-156", "queued"), ev("CHR-167", "queued"),
    ev("CHR-168", "queued"), ev("CHR-168", "blocked", { by: ["CHR-167"] }),
    ev("CHR-175", "queued"), ev("CHR-153", "queued"), ev("CHR-151", "queued"), ev("CHR-163", "queued"),
    ev("CHR-157", "launched", { worktree: charidel.contacts[0].lane!.worktree, frontend: "orca", terminal: charidel.contacts[0].lane!.terminal }),
    ev("CHR-157", "socket-up", { generation: 1 }),
    ev("CHR-157", "phase", { from: null, to: "isolate" }),
    ev("CHR-157", "phase", { from: "isolate", to: "execute" }),
    ev("CHR-157", "gate-armed", { gate: "wave-2" }),
    ev("CHR-157", "operator", { op: "approve", ok: true }),
    ev("CHR-157", "socket-down"),
    ev("CHR-157", "sample", { tracker: { state: "In Progress", url: "https://linear.app/charidel/issue/CHR-157" }, delivery: { url: "https://github.com/charidel/app/pull/441", state: "open", mergeable: "conflict", checks: "pass" }, omp: 4 }),
    ev("CHR-167", "launched", { worktree: charidel.contacts[3].lane!.worktree, frontend: "orca", terminal: charidel.contacts[3].lane!.terminal }),
    ev("CHR-167", "phase", { from: null, to: "execute" }),
    ev("CHR-167", "sample", { tracker: { state: "In Progress", url: "https://linear.app/charidel/issue/CHR-167" }, delivery: { url: "https://github.com/charidel/app/pull/452", state: "open", mergeable: "clean", checks: "pending" } }),
    ev("CHR-175", "launched", { worktree: charidel.contacts[5].lane!.worktree, frontend: "orca", terminal: charidel.contacts[5].lane!.terminal }),
    ev("CHR-175", "socket-up", { generation: 1 }),
    ev("CHR-175", "phase", { from: null, to: "execute" }),
    ev("CHR-175", "phase", { from: "execute", to: "verify" }),
    ev("CHR-175", "socket-down"),
    ev("CHR-175", "sample", { tracker: { state: "In Progress", url: "https://linear.app/charidel/issue/CHR-175" }, omp: 3 }),
    ev("CHR-153", "launched", { worktree: charidel.contacts[6].lane!.worktree, frontend: "orca", terminal: charidel.contacts[6].lane!.terminal }),
    ev("CHR-153", "socket-up", { generation: 1 }),
    ev("CHR-153", "phase", { from: null, to: "review" }),
    ev("CHR-153", "land-attempt", { outcome: "clean" }),
    ev("CHR-153", "landed", { via: "pr" }),
    ev("CHR-153", "reaped"),
    ev("CHR-153", "sample", { tracker: { state: "Done", url: "https://linear.app/charidel/issue/CHR-153" }, delivery: { url: "https://github.com/charidel/app/pull/438", state: "merged", mergeable: "clean", checks: "pass" } }),
    ev("CHR-157", "land-attempt", { outcome: "conflict", paths: ["desks/today.tsx", "schema/household.sql", "api/attendance.rs"] }),
    ev("CHR-157-CONFLICT-1", "queued", { source: "conflict" }),
    ev("CHR-157", "conflict-opened", { conflictContact: "CHR-157-CONFLICT-1" }),
    ev("CHR-157-CONFLICT-1", "launched", { worktree: charidel.contacts[1].lane!.worktree, frontend: "orca", terminal: charidel.contacts[1].lane!.terminal }),
    { v: 1, at: at(), kind: "workflow", item: "schema", done: true },
    { v: 1, at: at(), kind: "workflow", item: "seed", done: true },
  ] as Event[]) await appendEvent(home, "charidel", e);

  // ---- op 2: mission (all ports none), 3 zones, 4 contacts ----
  const mission = makeOp(home, {
    id: "mission", name: "omp-mission", base: "main",
    tracker: "none", fleet: "none", frontend: "none", delivery: "none",
    zones: [
      { id: "ctl", label: "CONTROL" },
      { id: "rev", label: "REVIEW" },
      { id: "host", label: "HOSTS" },
    ],
    contacts: [
      { ticket: "socket", title: "Operator socket", zone: "ctl", kind: "implement", blockedBy: [], conflictOf: null, lane: { worktree: join(home, "lanes", "mission", "socket"), branch: null, frontend: "external", terminal: null } },
      { ticket: "status", title: "Stable read model", zone: "ctl", kind: "implement", blockedBy: [], conflictOf: null },
      { ticket: "review", title: "Reviewer sessions", zone: "rev", kind: "audit", blockedBy: [], conflictOf: null, lane: { worktree: join(home, "lanes", "mission", "review"), branch: null, frontend: "external", terminal: null } },
      { ticket: "herdr", title: "Second frontend", zone: "host", kind: "implement", blockedBy: ["socket"], conflictOf: null },
    ],
  });
  await createOperation(home, mission);
  await writeNotes(home, "mission", "## Mission notes\n\n- [x] Contract documented\n- [ ] Status file v5 fields landed\n- [ ] Second frontend soak\n", (await readNotes(home, "mission")).revision);
  for (const e of [
    ev("socket", "adopted", { worktree: mission.contacts[0].lane!.worktree }),
    ev("status", "queued"),
    ev("review", "adopted", { worktree: mission.contacts[2].lane!.worktree }),
    ev("herdr", "queued"), ev("herdr", "blocked", { by: ["socket"] }),
    ev("socket", "phase", { from: null, to: "execute" }),
  ] as Event[]) await appendEvent(home, "mission", e);

  // ---- op 3: lab (all ports none), 2 zones, 2 contacts ----
  const lab = makeOp(home, {
    id: "lab", name: "Daedalus lab", base: "main",
    tracker: "none", fleet: "none", frontend: "none", delivery: "none",
    zones: [
      { id: "ops", label: "OPS" },
      { id: "docs", label: "DOCS" },
    ],
    contacts: [
      { ticket: "notes", title: "AGENTS topic files", zone: "docs", kind: "implement", blockedBy: [], conflictOf: null, lane: { worktree: join(home, "lanes", "lab", "notes"), branch: null, frontend: "external", terminal: null } },
      { ticket: "orca", title: "Pane death writeup", zone: "ops", kind: "implement", blockedBy: [], conflictOf: null },
    ],
  });
  await createOperation(home, lab);
  for (const e of [
    ev("notes", "adopted", { worktree: lab.contacts[0].lane!.worktree }),
    ev("orca", "queued"),
    ev("notes", "landed", { via: "manual" }),
  ] as Event[]) await appendEvent(home, "lab", e);

  return [charidel.id, mission.id, lab.id];
}
