import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operation } from "../../src/core/types.ts";
import {
  archiveOperation,
  createOperation,
  listOperations,
  mutateOperation,
  readOperation,
} from "../../src/store/operations.ts";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeOperation(home: string, id: string, extra: Partial<Operation> = {}): Operation {
  return {
    v: 1,
    id,
    name: `Op ${id}`,
    repo: join(home, "repo"),
    base: "main",
    integration: join(home, "repo"),
    pause: true,
    tracker: "none",
    fleet: "none",
    frontend: "none",
    delivery: "none",
    zones: [{ id: "ops", label: "Ops" }],
    contacts: [
      {
        ticket: "alpha",
        title: null,
        description: null,
        zone: "ops",
        kind: "decision",
        blockedBy: [],
        conflictOf: null,
        lane: null,
      },
    ],
    project: null,
    recover: false,
    createdAt: "2026-10-09T00:00:00.000Z",
    ...extra,
  };
}

describe("createOperation/readOperation", () => {
  test("round trips a valid operation at mode 0600", async () => {
    const home = tempHome();
    const op = makeOperation(home, "demo");
    expect(await createOperation(home, op)).toEqual(op);
    expect(statSync(join(home, "operations", "demo", "operation.json")).mode & 0o777).toBe(0o600);
    expect(await readOperation(home, "demo")).toEqual(op);
  });

  test("fails on a duplicate id", async () => {
    const home = tempHome();
    await createOperation(home, makeOperation(home, "demo"));
    await expect(createOperation(home, makeOperation(home, "demo"))).rejects.toThrow(
      'Operation "demo" already exists',
    );
  });

  test("rejects an invalid operation", async () => {
    const home = tempHome();
    await expect(
      createOperation(home, makeOperation(home, "Bad Id")),
    ).rejects.toThrow("Invalid operation at");
  });

  test("read of a missing operation throws", async () => {
    const home = tempHome();
    await expect(readOperation(home, "nope")).rejects.toThrow("Cannot read operation at");
  });
});

describe("mutateOperation", () => {
  test("applies a mutation and returns the stored operation", async () => {
    const home = tempHome();
    await createOperation(home, makeOperation(home, "demo"));
    const next = await mutateOperation(home, "demo", (op) => ({ ...op, name: "Renamed" }));
    expect(next.name).toBe("Renamed");
    expect((await readOperation(home, "demo")).name).toBe("Renamed");
  });

  test("two concurrent mutations both land", async () => {
    const home = tempHome();
    const op = makeOperation(home, "demo");
    await createOperation(home, op);
    const append = (n: number) =>
      mutateOperation(home, "demo", (current) => ({
        ...current,
        zones: [...current.zones, { id: `z-${n}-${current.zones.length}`, label: "x" }],
      }));
    // Two writers append a zone each; without serialization one would be lost.
    await Promise.all([append(1), append(2)]);
    expect((await readOperation(home, "demo")).zones).toHaveLength(3);
  });

  test("rejects an invalid result and leaves the file unchanged", async () => {
    const home = tempHome();
    const op = makeOperation(home, "demo");
    await createOperation(home, op);
    await expect(
      mutateOperation(home, "demo", (current) => ({ ...current, base: "has whitespace" })),
    ).rejects.toThrow("Invalid operation at");
    expect(await readOperation(home, "demo")).toEqual(op);
  });

  test("throws for a missing operation", async () => {
    const home = tempHome();
    await expect(mutateOperation(home, "nope", (op) => op)).rejects.toThrow("Cannot read operation at");
  });
});

describe("listOperations/archiveOperation", () => {
  test("empty home lists nothing", async () => {
    expect(await listOperations(tempHome())).toEqual([]);
  });

  test("lists open operations and hides archived by default", async () => {
    const home = tempHome();
    await createOperation(home, makeOperation(home, "alpha"));
    await createOperation(home, makeOperation(home, "beta"));
    await archiveOperation(home, "beta", new Date("2026-10-09T01:02:03Z"));
    expect(await listOperations(home)).toEqual([{ id: "alpha", name: "Op alpha", project: null, archived: false }]);
  });

  test("--all includes archived operations flagged", async () => {
    const home = tempHome();
    await createOperation(home, makeOperation(home, "alpha"));
    await createOperation(home, makeOperation(home, "beta"));
    const archiveName = await archiveOperation(home, "beta", new Date("2026-10-09T01:02:03Z"));
    expect(archiveName).toBe("beta-20261009010203");
    const all = await listOperations(home, { archived: true });
    expect(all).toContainEqual({ id: "alpha", name: "Op alpha", project: null, archived: false });
    expect(all).toContainEqual({ id: "beta", name: "Op beta", project: null, archived: true });
    expect(statSync(join(home, "archive", archiveName)).isDirectory()).toBe(true);
  });

  test("an invalid operation.json throws instead of being skipped", async () => {
    const home = tempHome();
    await createOperation(home, makeOperation(home, "demo"));
    await Bun.write(join(home, "operations", "demo", "operation.json"), "{broken");
    await expect(listOperations(home)).rejects.toThrow("Invalid JSON in operation at");
  });
});
