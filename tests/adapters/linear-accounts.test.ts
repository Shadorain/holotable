import { expect, test } from "bun:test";
import { linearTracker } from "../../src/adapters/tracker-linear.ts";
import { detectRepo } from "../../src/adapters/detector.ts";
import type { CommandResult, Run } from "../../src/ports.ts";

const ok = (payload: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: "" });
const text = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1): CommandResult => ({ code, stdout: "", stderr: "Unavailable workspace" });

function accounts() {
  const workspaces = new Map([["/lyricin", "lyricin"], ["/charidel", "Charidel"]]);
  const run: Run = async (command, args, cwd) => {
    if (command === "git") {
      const workspace = workspaces.get(cwd);
      return workspace ? text(workspace + "\n") : fail();
    }
    const workspace = args[args.indexOf("--workspace") + 1];
    if (workspace !== "lyricin" && workspace !== "Charidel") return fail();
    if (args[0] === "me") return ok({ viewer: { organization: { urlKey: workspace.toLowerCase() } } });
    const issue = { identifier: "APP-1", title: workspace, state: { name: workspace } };
    return ok(args[0] === "search" ? { issues: [issue] } : { issue });
  };
  return { run, workspaces };
}

test("one tracker keeps simultaneous account reads, searches and URL caches isolated", async () => {
  const { run, workspaces } = accounts();
  const tracker = linearTracker(run);
  const [lyricin, charidel] = await Promise.all([tracker.sample("APP-1", "/lyricin"), tracker.sample("APP-1", "/charidel")]);
  expect(lyricin).toEqual({ state: "lyricin", url: "https://linear.app/lyricin/issue/APP-1" });
  expect(charidel).toEqual({ state: "Charidel", url: "https://linear.app/charidel/issue/APP-1" });
  const [lyricsHits, charidelHits] = await Promise.all([tracker.search("query", "/lyricin", 5), tracker.search("query", "/charidel", 5)]);
  expect(lyricsHits?.[0]).toEqual({ ticket: "APP-1", title: "lyricin", state: "lyricin", url: lyricin?.url ?? null });
  expect(charidelHits?.[0]).toEqual({ ticket: "APP-1", title: "Charidel", state: "Charidel", url: charidel?.url ?? null });
  workspaces.set("/lyricin", "Charidel");
  expect(await tracker.sample("APP-1", "/lyricin")).toEqual(charidel);
});

test("a failed selected account or configuration lookup never reads the CLI default", async () => {
  const linearCalls: string[][] = [];
  let configCode = 0;
  const run: Run = async (command, args) => {
    if (command === "git") return configCode ? fail(configCode) : text("missing\n");
    linearCalls.push(args);
    if (args.includes("--workspace")) return fail();
    return ok({ issue: { state: { name: "Wrong account" } }, issues: [] });
  };
  const tracker = linearTracker(run);
  expect(await tracker.sample("APP-1", "/repo")).toBeNull();
  expect(await tracker.search("query", "/repo", 5)).toBeNull();
  expect(linearCalls).toHaveLength(2);
  expect(linearCalls.every((args) => args.includes("missing"))).toBe(true);
  configCode = 2;
  expect(await tracker.sample("APP-1", "/repo")).toBeNull();
  expect(linearCalls).toHaveLength(2);
});

test("repository detection authenticates its selected workspace rather than the CLI default", async () => {
  let authenticated = true;
  const run: Run = async (command, args, cwd) => {
    if (command === "git") {
      if (args[0] === "rev-parse") return text(cwd);
      if (args[0] === "config") return text("lyricin\n");
      return fail();
    }
    if (command === "lin" && args.includes("lyricin") && authenticated) return ok({ viewer: {} });
    return fail();
  };
  const detected = await detectRepo("/lyricin", run, []);
  expect(detected.fields.tracker).toBe("linear");
  authenticated = false;
  expect((await detectRepo("/lyricin", run, [])).fields.tracker).toBe("none");
});
