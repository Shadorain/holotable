import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../../src/core/projection.ts";
import type { Contact, Operation } from "../../src/core/types.ts";
import { readEvents } from "../../src/store/events.ts";
import { createOperation, readOperation } from "../../src/store/operations.ts";
import { holotableToolDefs } from "../../src/plugin/tools.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { startBoard } from "../../src/service.ts";
import { fakePorts, noRun } from "../helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const contact = (ticket: string, over: Partial<Contact> = {}): Contact => ({
  ticket,
  title: null,
  zone: "ops",
  kind: "implement",
  blockedBy: [],
  conflictOf: null,
  lane: null,
  ...over,
});

async function setup(contacts: Contact[]) {
  const home = mkdtempSync(join(tmpdir(), "holotable-tools-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const op: Operation = {
    v: 1,
    id: "lab",
    name: "Lab",
    repo: "/tmp/lab",
    base: "main",
    integration: "/tmp/lab",
    pause: true,
    tracker: "none",
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "none",
    zones: [
      { id: "ops", label: "Ops" },
      { id: "ship", label: "Ship" },
    ],
    contacts,
    project: null,
    recover: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await createOperation(home, op);
  const tools = holotableToolDefs({ home, current: () => "lab", now: () => new Date("2026-01-02T00:00:00Z") });
  return { home, state: tools.state, queue: tools.queue };
}

test("holotable_state stays within 4000 chars on a 200-contact operation and says what was cut", async () => {
  const many = Array.from({ length: 200 }, (_, i) => contact(`task-${i}`, { title: "A".repeat(40) }));
  const { state } = await setup(many);
  const text = await state.execute({});
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toMatch(/… \d+ more contacts$/);
  expect(text.split("\n")[0]).toContain("200 contacts");
});

test("holotable_state shows state and blockers for each contact", async () => {
  const { state } = await setup([contact("a"), contact("b", { blockedBy: ["a"] }), contact("n", { kind: "decision" })]);
  const lines = (await state.execute({})).split("\n");
  expect(lines.slice(1).map((l) => l.split(" ").slice(0, 4).join(" "))).toEqual([
    "a ops implement ready",
    "b ops implement blocked",
    "n ops decision decision",
  ]);
  expect(lines[2]).toContain("blockedBy=a");
});

test("holotable_state prefers the running service's projection and falls back to the store", async () => {
  const { home, state } = await setup([contact("a")]);
  const board = await startBoard({
    home,
    settings: { ...DEFAULT_SETTINGS, port: 0, pollMs: 60_000, sampleMs: 60_000 },
    run: noRun,
    portsFor: () => fakePorts().ports,
  });
  cleanup.push(() => board.close());
  const text = await state.execute({ operation: "lab" });
  expect(text).toContain("a ops implement ready");
});

test("holotable_queue adds a queued contact, with queued and blocked events", async () => {
  const { home, queue } = await setup([contact("a")]);
  await queue.execute({ action: "add", ticket: "b", zone: "ship", blockedBy: ["a"], title: "Later" });
  const op = await readOperation(home, "lab");
  expect(op.contacts.at(-1)).toMatchObject({ ticket: "b", zone: "ship", title: "Later", blockedBy: ["a"], lane: null });
  expect((await readEvents(home, "lab")).map((e) => e.kind)).toEqual(["queued", "blocked"]);
});

test("holotable_queue update edits a queued contact and refuses a launched one", async () => {
  const launched = contact("live", {
    lane: { worktree: "/tmp/wt", branch: null, frontend: "orca", terminal: { handle: "t", incarnationId: "i" } },
  });
  const { home, queue } = await setup([contact("a"), launched]);
  await queue.execute({ action: "update", ticket: "a", zone: "ship", kind: "audit" });
  expect((await readOperation(home, "lab")).contacts[0]).toMatchObject({ zone: "ship", kind: "audit" });
  await expect(queue.execute({ action: "update", ticket: "live", zone: "ship" })).rejects.toThrow("contact-launched");
  expect((await readOperation(home, "lab")).contacts[1]?.zone).toBe("ops");
  await expect(queue.execute({ action: "update", ticket: "ghost", zone: "ship" })).rejects.toThrow('No contact "ghost"');
  await expect(queue.execute({ action: "add", ticket: "x" })).rejects.toThrow("zone is required");
});

test("holotable_queue rejects verbs other than add and update and ignores lane fields", async () => {
  const { home, queue } = await setup([contact("a")]);
  await expect(queue.execute({ action: "launch", ticket: "a" })).rejects.toThrow("add or update");
  await queue.execute({
    action: "update",
    ticket: "a",
    title: "Renamed",
    lane: { worktree: "/etc", branch: null, frontend: "orca", terminal: null },
  });
  expect((await readOperation(home, "lab")).contacts[0]).toMatchObject({ title: "Renamed", lane: null });
});

test("the model's queue changes are attributed to it, in the event log and on the contact", async () => {
  const { home, queue } = await setup([contact("a")]);
  await queue.execute({ action: "add", ticket: "b", zone: "ops" });
  await queue.execute({ action: "update", ticket: "a", title: "Renamed", zone: "ship" });
  const events = await readEvents(home, "lab");
  expect(events.find((e) => e.kind === "queued")).toMatchObject({ contact: "b", source: "model" });
  expect(events.find((e) => e.kind === "edited")).toMatchObject({ contact: "a", source: "model", fields: ["zone", "title"] });
  const op = await readOperation(home, "lab");
  const p = project({ operation: op, events, statuses: {}, owners: {}, probes: {}, load: { live: 0, open: 0 }, cap: 8, now: Date.now(), project: null, notesText: null });
  expect(p.contacts.find((c) => c.ticket === "b")?.origin).toMatchObject({ actor: "model", text: "queued by the model" });
});
