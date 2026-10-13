import { describe, expect, test } from "bun:test";
import { githubTracker } from "../../src/adapters/tracker-github.ts";
import { linearTracker } from "../../src/adapters/tracker-linear.ts";
import type { CommandResult, Run } from "../../src/ports.ts";

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

function fakeRun(result: CommandResult | ((call: Call) => CommandResult)): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd) => {
    const call = { command, args, cwd };
    calls.push(call);
    return typeof result === "function" ? result(call) : result;
  };
  return { run, calls };
}

describe("linearTracker", () => {
  test("returns state and url from lin JSON", async () => {
    const { run, calls } = fakeRun({
      stdout: JSON.stringify({ issue: { identifier: "CHR-1", state: { name: "In Progress" }, url: "https://linear.app/x/CHR-1" } }),
      stderr: "",
      code: 0,
    });
    const tracker = linearTracker(run);
    expect(await tracker.sample("chr-1", "/repo")).toEqual({ state: "In Progress", url: "https://linear.app/x/CHR-1" });
    expect(calls[0].command).toBe("lin");
    expect(calls[0].args).toEqual(["issues", "get", "CHR-1", "--json"]);
    expect(calls[0].cwd).toBe("/repo");
  });

  test("builds the workspace issue URL when lin omits url", async () => {
    const { run, calls } = fakeRun((call) => {
      if (call.args[0] === "me") {
        return { stdout: JSON.stringify({ viewer: { organization: { urlKey: "charidel" } } }), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ issue: { identifier: "CHR-173", state: { name: "Todo" } } }), stderr: "", code: 0 };
    });
    expect(await linearTracker(run).sample("chr-173", "/repo")).toEqual({
      state: "Todo",
      url: "https://linear.app/charidel/issue/CHR-173",
    });
    expect(calls.map((call) => call.args[0])).toEqual(["issues", "me"]);
  });

  test("does not invent a pull request from a numeric ticket", async () => {
    const { run, calls } = fakeRun({
      stdout: JSON.stringify({ issue: { identifier: "173", state: { name: "Todo" } } }),
      stderr: "",
      code: 0,
    });
    expect(await linearTracker(run).sample("173", "/repo")).toEqual({ state: "Todo", url: null });
    expect(calls.some((call) => call.args[0] === "me")).toBe(false);
  });

  test("null on non-zero exit, bad JSON, or missing fields", async () => {
    expect(await linearTracker(fakeRun({ stdout: "err", stderr: "", code: 1 }).run).sample("CHR-1", "/r")).toBeNull();
    expect(await linearTracker(fakeRun({ stdout: "not json", stderr: "", code: 0 }).run).sample("CHR-1", "/r")).toBeNull();
    expect(
      await linearTracker(fakeRun({ stdout: JSON.stringify({ issue: {} }), stderr: "", code: 0 }).run).sample("CHR-1", "/r"),
    ).toBeNull();
  });

  test("a throwing run yields null", async () => {
    const run: Run = async () => {
      throw new Error("spawn failed");
    };
    expect(await linearTracker(run).sample("CHR-1", "/r")).toBeNull();
  });
});

describe("githubTracker", () => {
  test("owner/repo#N form passes --repo", async () => {
    const { run, calls } = fakeRun({ stdout: JSON.stringify({ state: "OPEN", url: "u" }), stderr: "", code: 0 });
    expect(await githubTracker(run).sample("acme/widgets#42", "/repo")).toEqual({ state: "open", url: "u" });
    expect(calls[0].args).toEqual(["issue", "view", "42", "--repo", "acme/widgets", "--json", "state,url"]);
  });

  test("#N form runs in cwd without --repo", async () => {
    const { run, calls } = fakeRun({ stdout: JSON.stringify({ state: "CLOSED", url: "u" }), stderr: "", code: 0 });
    expect(await githubTracker(run).sample("#7", "/checkout")).toEqual({ state: "closed", url: "u" });
    expect(calls[0].args).toEqual(["issue", "view", "7", "--json", "state,url"]);
    expect(calls[0].cwd).toBe("/checkout");
  });

  test("null on failure, bad ticket, or missing state", async () => {
    expect(await githubTracker(fakeRun({ stdout: "", stderr: "", code: 1 }).run).sample("#7", "/r")).toBeNull();
    expect(await githubTracker(fakeRun({ stdout: "{}", stderr: "", code: 0 }).run).sample("#7", "/r")).toBeNull();
    expect(await githubTracker(fakeRun({ stdout: "{}", stderr: "", code: 0 }).run).sample("bogus", "/r")).toBeNull();
  });

  test("a pull request URL is not the ticket link", async () => {
    const { run } = fakeRun({
      stdout: JSON.stringify({ state: "OPEN", url: "https://github.com/acme/widgets/pull/42" }),
      stderr: "",
      code: 0,
    });
    expect(await githubTracker(run).sample("#42", "/repo")).toEqual({ state: "open", url: null });
  });
});

describe("linearTracker.search", () => {
  test("maps issues to hits and passes query, limit and cwd", async () => {
    const { run, calls } = fakeRun({
      stdout: JSON.stringify({
        issues: [
          { identifier: "CHR-170", title: "Office kiosk", state: { name: "Backlog" }, team: { key: "CHR" } },
          { identifier: "CHR-171", title: "Portal invite", state: {} },
        ],
        documents: [],
        projects: [],
      }),
      stderr: "",
      code: 0,
    });
    const hits = await linearTracker(run).search("kiosk", "/repo", 8);
    expect(calls[0].command).toBe("lin");
    expect(calls[0].args).toEqual(["search", "kiosk", "--json", "--limit", "8"]);
    expect(calls[0].cwd).toBe("/repo");
    expect(hits).toEqual([
      { ticket: "CHR-170", title: "Office kiosk", state: "Backlog", url: null },
      { ticket: "CHR-171", title: "Portal invite", state: null, url: null },
    ]);
  });

  test("null on non-zero exit, bad payload, or a throwing run", async () => {
    expect(await linearTracker(fakeRun({ stdout: "err", stderr: "", code: 1 }).run).search("x", "/r", 5)).toBeNull();
    expect(await linearTracker(fakeRun({ stdout: "not json", stderr: "", code: 0 }).run).search("x", "/r", 5)).toBeNull();
    expect(await linearTracker(fakeRun({ stdout: "{}", stderr: "", code: 0 }).run).search("x", "/r", 5)).toBeNull();
    const run: Run = async () => {
      throw new Error("spawn failed");
    };
    expect(await linearTracker(run).search("x", "/r", 5)).toBeNull();
  });

  test("an empty issues array is an empty answer, not a failure", async () => {
    const hits = await linearTracker(fakeRun({ stdout: JSON.stringify({ issues: [] }), stderr: "", code: 0 }).run).search("x", "/r", 5);
    expect(hits).toEqual([]);
  });
});

describe("githubTracker.search", () => {
  test("maps issues to #N tickets that sample can resolve", async () => {
    const { run, calls } = fakeRun({
      stdout: JSON.stringify([
        { number: 42, title: "Fix the race", state: "OPEN", url: "https://github.com/acme/widgets/issues/42" },
        { number: 43, title: "Docs", state: "CLOSED", url: "https://github.com/acme/widgets/issues/43" },
      ]),
      stderr: "",
      code: 0,
    });
    const hits = await githubTracker(run).search("race", "/checkout", 8);
    expect(calls[0].args).toEqual(["issue", "list", "--search", "race", "--json", "number,title,state,url", "--limit", "8"]);
    expect(calls[0].cwd).toBe("/checkout");
    expect(hits).toEqual([
      { ticket: "#42", title: "Fix the race", state: "open", url: "https://github.com/acme/widgets/issues/42" },
      { ticket: "#43", title: "Docs", state: "closed", url: "https://github.com/acme/widgets/issues/43" },
    ]);
  });

  test("null on non-zero exit, bad payload, or a throwing run", async () => {
    expect(await githubTracker(fakeRun({ stdout: "err", stderr: "", code: 1 }).run).search("x", "/r", 5)).toBeNull();
    expect(await githubTracker(fakeRun({ stdout: "{}", stderr: "", code: 0 }).run).search("x", "/r", 5)).toBeNull();
    const run: Run = async () => {
      throw new Error("spawn failed");
    };
    expect(await githubTracker(run).search("x", "/r", 5)).toBeNull();
  });
});
