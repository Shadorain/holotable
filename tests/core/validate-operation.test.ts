import { describe, expect, test } from "bun:test";
import {
  normalizeTicket,
  validateOperation,
} from "../../src/core/validate-operation.ts";
import type { Operation } from "../../src/core/types.ts";

type RawOp = {
  v: number;
  id: string;
  name: string;
  repo: string;
  integration?: string;
  base: string;
  pause: boolean;
  tracker: string;
  fleet: string;
  frontend: string;
  delivery: string;
  zones: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  workflow: Array<Record<string, unknown>>;
  createdAt: string;
  [key: string]: unknown;
};

const base = (): RawOp => ({
  v: 1,
  id: "op1",
  name: "Op One",
  repo: "/repo",
  integration: "/repo",
  base: "main",
  pause: false,
  tracker: "none",
  fleet: "none",
  frontend: "none",
  delivery: "none",
  zones: [{ id: "z1", label: "Zone 1" }],
  contacts: [],
  workflow: [],
  createdAt: "2026-01-01T00:00:00.000Z",
});

const contact = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ticket: "a",
  title: null,
  description: null,
  zone: "z1",
  kind: "implement",
  blockedBy: [],
  conflictOf: null,
  lane: null,
  ...over,
});

const bad = (v: unknown, path?: string): string => {
  try {
    validateOperation(v, path);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("validateOperation", () => {
  test("accepts a minimal valid operation", () => {
    const op = validateOperation(base());
    expect(op.id).toBe("op1");
    expect(op.contacts).toEqual([]);
  });

  test("error prefix is Invalid operation at <path>", () => {
    expect(bad(null)).toBe("Invalid operation at operation.json: expected a JSON object");
    expect(bad(null, "custom/path.json")).toContain("custom/path.json");
  });

  test("rejects bad id", () => {
    expect(bad({ ...base(), id: "Bad_Id" })).toContain("id must match");
    expect(bad({ ...base(), id: "-lead" })).toContain("id must match");
    expect(bad({ ...base(), id: "a".repeat(49) })).toContain("id must match");
  });

  test("rejects empty and long names", () => {
    expect(bad({ ...base(), name: "" })).toContain("name");
    expect(bad({ ...base(), name: "x".repeat(81) })).toContain("name");
  });

  test("rejects relative repo and missing integration", () => {
    expect(bad({ ...base(), repo: "rel/path" })).toContain("repo must be an absolute path");
    const noInt = { ...base() };
    delete noInt.integration;
    expect(bad(noInt)).toContain("integration must be an absolute path");
  });

  test("rejects whitespace in base", () => {
    expect(bad({ ...base(), base: "main x" })).toContain("base");
    expect(bad({ ...base(), base: "" })).toContain("base");
    expect(bad({ ...base(), base: "x".repeat(201) })).toContain("base");
  });

  test("rejects unknown enum values", () => {
    expect(bad({ ...base(), tracker: "jira" })).toContain("tracker must be one of");
    expect(bad({ ...base(), frontend: "tmux" })).toContain("frontend must be one of");
  });

  test("zones: bounds, id pattern, duplicates, labels", () => {
    expect(bad({ ...base(), zones: Array(9).fill({ id: "z", label: "L" }) })).toContain("at most 8");
    expect(bad({ ...base(), zones: [{ id: "Z_!", label: "L" }] })).toContain("zones[0].id");
    expect(
      bad({ ...base(), zones: [{ id: "z", label: "L" }, { id: "z", label: "M" }] }),
    ).toContain("duplicate");
    expect(bad({ ...base(), zones: [{ id: "z", label: "" }] })).toContain("label");
  });

  test("contact must name an existing zone", () => {
    const op = base();
    op.contacts = [contact({ zone: "nope" })];
    expect(bad(op)).toContain("zone");
  });

  test("rejects self block, unknown blocker, and cycles", () => {
    let op = base();
    op.contacts = [contact({ ticket: "a", blockedBy: ["a"] })];
    expect(bad(op)).toContain("itself");
    op.contacts = [contact({ ticket: "a", blockedBy: ["ghost"] })];
    expect(bad(op)).toContain("not a contact ticket");
    op.contacts = [
      contact({ ticket: "a", blockedBy: ["b"] }),
      contact({ ticket: "b", blockedBy: ["a"] }),
    ];
    expect(bad(op)).toContain("cycle");
  });

  test("conflict contact requires conflictOf and only conflicts carry it", () => {
    let op = base();
    op.contacts = [contact({ ticket: "a" }), contact({ ticket: "a-con-1", kind: "conflict" })];
    expect(bad(op)).toContain("conflictOf is required");
    op.contacts = [contact({ ticket: "a" }), contact({ ticket: "b", conflictOf: "a" })];
    expect(bad(op)).toContain("only allowed on conflict contacts");
    op.contacts = [
      contact({ ticket: "a" }),
      contact({ ticket: "a-cf-1", kind: "conflict", conflictOf: "a" }),
    ];
    expect(validateOperation(op).contacts[1].conflictOf).toBe("a");
  });

  test("conflictOf must reference an existing contact", () => {
    const op = base();
    op.contacts = [contact({ ticket: "a-c-1", kind: "conflict", conflictOf: "gone" })];
    expect(bad(op)).toContain("not a contact ticket");
  });
  test("contact description rejects malformed values", () => {
    for (const description of [123, {}]) {
      const op = base();
      op.contacts = [contact({ ticket: "a", description })];
      expect(() => validateOperation(op)).toThrow();
    }
  });


  test("relative lane.worktree and bare terminal are rejected", () => {
    let op = base();
    op.contacts = [
      contact({
        ticket: "a",
        lane: { worktree: "rel", branch: null, frontend: "external", terminal: null },
      }),
    ];
    expect(bad(op)).toContain("absolute");
    op = base();
    op.contacts = [contact({ ticket: "a", terminal: { handle: "h", incarnationId: "i" } })];
    expect(bad(op)).toContain("lane.terminal requires lane");
  });

  test("ticket validation per tracker; linear normalizes to upper-case", () => {
    const linear = { ...base(), tracker: "linear" };
    linear.contacts = [contact({ ticket: "chr-142" })];
    const op = validateOperation(linear);
    expect(op.contacts[0].ticket).toBe("CHR-142");
    const badLinear = { ...base(), tracker: "linear" };
    badLinear.contacts = [contact({ ticket: "chr142" })];
    expect(bad(badLinear)).toContain("not a valid linear ticket");

    const gh = { ...base(), tracker: "github" };
    gh.contacts = [contact({ ticket: "o/r#12" })];
    expect(validateOperation(gh).contacts[0].ticket).toBe("o/r#12");
    gh.contacts = [contact({ ticket: "oops" })];
    expect(bad(gh)).toContain("not a valid github ticket");

    const none = { ...base(), tracker: "none" };
    none.contacts = [contact({ ticket: "0leading-digit-ok" })];
    expect(validateOperation(none).contacts[0].ticket).toBe("0leading-digit-ok");
    none.contacts = [contact({ ticket: "-bad" })];
    expect(bad(none)).toContain("not a valid none ticket");
  });

  test("duplicate tickets after normalization are rejected", () => {
    const op = { ...base(), tracker: "linear" };
    op.contacts = [contact({ ticket: "chr-1" }), contact({ ticket: "CHR-1" })];
    expect(bad(op)).toContain("duplicate");
  });

  test("blockedBy and conflictOf are normalized to stored ticket case", () => {
    const op = { ...base(), tracker: "linear" };
    op.contacts = [
      contact({ ticket: "chr-1" }),
      contact({ ticket: "chr-2", blockedBy: ["chr-1"] }),
      contact({ ticket: "chr-1-c-1", kind: "conflict", conflictOf: "chr-1" }),
    ];
    const v = validateOperation(op);
    expect(v.contacts[1].blockedBy).toEqual(["CHR-1"]);
    expect(v.contacts[2].conflictOf).toBe("CHR-1");
  });

  test("contacts cap at 200 and workflow at 30", () => {
    const op = base();
    op.contacts = Array.from({ length: 201 }, (_, i) => contact({ ticket: `t${i}` }));
    expect(bad(op)).toContain("at most 200");
    op.contacts = [];
    op.workflow = Array.from({ length: 31 }, (_, i) => ({ id: `w${i}`, label: "x" }));
    expect(bad(op)).toContain("at most 30");
    op.workflow = [{ id: "A", label: "x" }];
    expect(bad(op)).toContain("workflow[0].id");
    op.workflow = [
      { id: "w", label: "x" },
      { id: "w", label: "y" },
    ];
    expect(bad(op)).toContain("duplicate");
  });

  test("serialized size must be under 1 MiB", () => {
    const op = base();
    op.contacts = [contact({ ticket: "a", title: "x".repeat(1024 * 1024) })];
    expect(bad(op)).toContain("under 1 MiB");
  });

  test("conflict contact uses freeform ticket even under linear tracker", () => {
    const op = { ...base(), tracker: "linear" };
    op.contacts = [
      contact({ ticket: "CHR-1" }),
      contact({ ticket: "chr-1-conflict-9", kind: "conflict", conflictOf: "chr-1" }),
    ];
    const v = validateOperation(op);
    expect(v.contacts[1].ticket).toBe("CHR-1-CONFLICT-9");
  });
});

describe("normalizeTicket", () => {
  test("linear trims and upper-cases; others trim only", () => {
    expect(normalizeTicket("linear", " chr-7 ")).toBe("CHR-7");
    expect(normalizeTicket("github", " o/r#3 ")).toBe("o/r#3");
    expect(normalizeTicket("none", " tick ")).toBe("tick");
  });
});

test("validated output round-trips Operation type", () => {
  const op: Operation = validateOperation(base());
  expect(op.v).toBe(1);
});
