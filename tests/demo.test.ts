import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDemo } from "../examples/demo.ts";
import { foldEvents, liveCount } from "../src/core/fold.ts";
import { project } from "../src/core/projection.ts";
import type { ContactState } from "../src/core/types.ts";
import { readEvents } from "../src/store/events.ts";
import { readOperation } from "../src/store/operations.ts";

describe("demo seed", () => {
  test("three operations validate, project and cover the demo states", async () => {
    const home = mkdtempSync(join(tmpdir(), "holotable-demo-"));
    try {
      const ids = await seedDemo(home);
      expect(ids).toEqual(["charidel", "mission", "lab"]);

      const states = new Set<ContactState>();
      for (const id of ids) {
        const operation = await readOperation(home, id);
        const events = await readEvents(home, id);
        const now = Date.now();
        const projection = project({
          operation,
          project: null,
          notesText: null,
          events,
          statuses: {},
          owners: {},
          load: { live: liveCount(operation, foldEvents(events)), open: 0 },
          probes: {},
          cap: 8,
          now,
        });
        expect(projection.operation.id).toBe(id);
        for (const c of projection.contacts) states.add(c.state);
      }
      for (const state of ["ready", "blocked", "planning", "landed"] as const)
        expect(states.has(state), `expected a ${state} contact`).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
