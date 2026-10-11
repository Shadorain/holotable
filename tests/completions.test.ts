import { expect, test } from "bun:test";
import { holotableCompletions, type CompletionSnapshot } from "../src/completions.ts";

const snapshot: CompletionSnapshot = {
  operations: [
    { id: "charidel", name: "Charidel", archived: false },
    { id: "lab", name: "Lab", archived: false },
    { id: "old", name: "Old", archived: true },
  ],
  current: { id: "lab", zones: ["ops", "ship"], tickets: ["CHR-1", "CHR-2"] },
  projects: [{ id: "lab-proj", name: "Lab" }],
};
const values = (prefix: string) => holotableCompletions(prefix, snapshot)?.map((i) => i.value) ?? null;

test("subcommands complete by prefix and return null when nothing matches", () => {
  expect(values("")).toContain("new ");
  expect(values("se")).toEqual(["set "]);
  expect(values("zzz")).toBeNull();
});

test("use and close complete open operations only", () => {
  expect(values("use ")).toEqual(["use charidel ", "use lab "]);
  expect(values("use ch")).toEqual(["use charidel "]);
  expect(values("close o")).toBeNull();
  expect(values("close lab ")).toEqual(["close lab landed ", "close lab abandoned ", "close lab decision ", "close lab failed "]);
});

test("set and config complete fields then enum values", () => {
  expect(values("set fr")).toEqual(["set frontend "]);
  expect(values("set frontend ")).toEqual(["set frontend orca ", "set frontend herdr ", "set frontend custom ", "set frontend none "]);
  expect(values("config cap ")?.length).toBe(64);
  expect(values("config defaults.tr")).toEqual(["config defaults.tracker "]);
  expect(values("set base ")).toBeNull();
});

test("new completes flag names, enum values and skips used flags", () => {
  expect(values("new lab --tr")).toEqual(["new lab --tracker "]);
  expect(values("new lab --tracker l")).toEqual(["new lab --tracker linear "]);
  expect(values("new lab --repo /x --no")).toEqual(["new lab --repo /x --no-pause "]);
  // --repo is used, so --re only offers --recover.
  expect(values("new lab --repo /x --re")).toEqual(["new lab --repo /x --recover "]);
  expect(values("new lab")).toBeNull();
});

test("add completes zones, kinds and comma-separated blockers", () => {
  expect(values("add CHR-3 --zone ")).toEqual(["add CHR-3 --zone ops ", "add CHR-3 --zone ship "]);
  expect(values("add CHR-3 --kind d")).toEqual(["add CHR-3 --kind decision "]);
  expect(values("add CHR-3 --blocked-by CHR-1,")).toEqual(["add CHR-3 --blocked-by CHR-1,CHR-2 "]);
  expect(holotableCompletions("add x --zone ", { operations: [], current: null, projects: [] })).toBeNull();
});
