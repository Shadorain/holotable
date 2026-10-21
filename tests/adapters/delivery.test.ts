import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contact, ContactStatus, Operation } from "../../src/core/types.ts";
import { githubPrDelivery } from "../../src/adapters/delivery-github-pr.ts";
import { localMergeDelivery } from "../../src/adapters/delivery-local-merge.ts";
import { type CommandResult, type Run } from "../../src/ports.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-delivery-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeOperation(home: string): Operation {
  return {
    v: 1,
    id: "demo",
    name: "Demo",
    repo: join(home, "repo"),
    base: "main",
    integration: join(home, "repo"),
    pause: true,
    ignoreChecks: false,
    tracker: "github",
    fleet: "omp-mission",
    frontend: "none",
    delivery: "github-pr",
    zones: [],
    contacts: [],
    project: null,
    recover: false,
    createdAt: "2026-10-09T00:00:00.000Z",
  };
}

function makeContact(branch: string | null): Contact {
  return {
    ticket: "acme/w#1",
    title: null,
    zone: "ops",
    kind: "implement",
    blockedBy: [],
    conflictOf: null,
    lane: branch ? { worktree: "/wt", branch, frontend: "orca", terminal: null } : null,
  };
}

function makeStatus(branch: string | null): ContactStatus {
  return { delivery: branch ? { url: null, branch } : null } as ContactStatus;
}

function fakeRun(result: CommandResult): { run: Run; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run: Run = async (_command, args, cwd) => {
    calls.push({ args, cwd });
    return result;
  };
  return { run, calls };
}

describe("githubPrDelivery.probe", () => {
  test("maps a mergeable open PR with passing checks", async () => {
    const home = tempDir();
    const { run, calls } = fakeRun({
      stdout: JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        url: "https://github.com/x/pull/1",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      stderr: "",
      code: 0,
    });
    const probe = await githubPrDelivery(run).probe({
      operation: makeOperation(home),
      contact: makeContact(null),
      status: makeStatus("holotable/feat"),
    });
    expect(probe).toEqual({
      url: "https://github.com/x/pull/1",
      state: "open",
      mergeable: "clean",
      checks: "pass",
    });
    expect(calls[0].args.slice(0, 3)).toEqual(["pr", "view", "holotable/feat"]);
    expect(calls[0].cwd).toBe(join(home, "repo"));
  });

  test("falls back to lane.branch when status.delivery is null", async () => {
    const home = tempDir();
    const { run, calls } = fakeRun({ stdout: "{}", stderr: "", code: 1 });
    await githubPrDelivery(run).probe({ operation: makeOperation(home), contact: makeContact("lane-b"), status: makeStatus(null) });
    expect(calls[0].args[2]).toBe("lane-b");
  });

  test("conflicting and pending mappings", async () => {
    const home = tempDir();
    const conflict = fakeRun({ stdout: JSON.stringify({ state: "OPEN", mergeable: "CONFLICTING", url: null, statusCheckRollup: [] }), stderr: "", code: 0 });
    expect(
      await githubPrDelivery(conflict.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }),
    ).toEqual({ url: null, state: "open", mergeable: "conflict", checks: "none" });

    const pending = fakeRun({ stdout: JSON.stringify({ state: "OPEN", mergeable: "UNKNOWN", url: null, statusCheckRollup: [{ status: "IN_PROGRESS" }] }), stderr: "", code: 0 });
    const probe = await githubPrDelivery(pending.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) });
    expect(probe).toMatchObject({ mergeable: "unknown", checks: "pending" });
  });

  test("a queued check gh reports with an empty conclusion is pending, not passing", async () => {
    // gh prints conclusion "" (not null) until a check run completes; reading that as done let Land merge
    // PR #313 while its CI was still queued.
    const home = tempDir();
    const rollup = [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "QUEUED", conclusion: "" }, { status: "IN_PROGRESS", conclusion: "" }];
    const { run } = fakeRun({ stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", url: null, statusCheckRollup: rollup }), stderr: "", code: 0 });
    expect((await githubPrDelivery(run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }))?.checks).toBe("pending");
  });

  test("a run superseded by a newer run of the same check does not fail the PR", async () => {
    // Concurrency cancels the older run of PR #317's policy check; the queued rerun is what counts.
    const home = tempDir();
    const policy = { workflowName: "Verification policy protection", name: "Verify policy change explanation" };
    const probe = async (rollup: unknown[]) => (await githubPrDelivery(fakeRun({ stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", url: null, statusCheckRollup: rollup }), stderr: "", code: 0 }).run)
      .probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }));
    const cancelled = { ...policy, status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-21T06:16:06Z" };
    expect(await probe([cancelled, { ...policy, status: "QUEUED", conclusion: "", startedAt: "2026-10-21T06:16:13Z" }])).toMatchObject({ checks: "pending" });
    expect(await probe([{ ...policy, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-21T06:20:00Z" }, cancelled])).toMatchObject({ checks: "pass" });
    // The newest run failing still fails, and a same-named job in another workflow is judged on its own.
    const failed = await probe([{ ...policy, status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-21T06:30:00Z" }, { workflowName: "Rust checks", name: policy.name, status: "COMPLETED", conclusion: "SUCCESS" }]);
    expect(failed).toMatchObject({ checks: "fail", failing: [policy.name] });
  });

  test("a failing check maps to fail", async () => {
    const home = tempDir();
    const { run } = fakeRun({ stdout: JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", url: null, statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }), stderr: "", code: 0 });
    expect(
      (await githubPrDelivery(run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }))?.checks,
    ).toBe("fail");
  });

  test("merged state, null branch, and gh failure", async () => {
    const home = tempDir();
    const merged = fakeRun({ stdout: JSON.stringify({ state: "MERGED", mergeable: "UNKNOWN", url: "u", statusCheckRollup: [] }), stderr: "", code: 0 });
    expect(
      (await githubPrDelivery(merged.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }))?.state,
    ).toBe("merged");
    const noBranch = fakeRun({ stdout: "", stderr: "", code: 0 });
    expect(
      await githubPrDelivery(noBranch.run).probe({ operation: makeOperation(home), contact: makeContact(null), status: makeStatus(null) }),
    ).toBeNull();
    const failing = fakeRun({ stdout: "", stderr: "", code: 1 });
    expect(
      await githubPrDelivery(failing.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }),
    ).toBeNull();
  });
});

describe("localMergeDelivery.probe", () => {
  test("ancestor check yields merged/open", async () => {
    const home = tempDir();
    const merged = fakeRun({ stdout: "", stderr: "", code: 0 });
    expect(
      await localMergeDelivery(merged.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }),
    ).toEqual({ url: null, state: "merged", mergeable: "unknown", checks: "none" });
    expect(merged.calls[0].args).toEqual(["merge-base", "--is-ancestor", "b", "main"]);

    const open = fakeRun({ stdout: "", stderr: "", code: 1 });
    expect(
      (await localMergeDelivery(open.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }))?.state,
    ).toBe("open");

    const weird = fakeRun({ stdout: "", stderr: "", code: 128 });
    expect(
      await localMergeDelivery(weird.run).probe({ operation: makeOperation(home), contact: makeContact("b"), status: makeStatus(null) }),
    ).toBeNull();
  });

  test("null when no branch is known", async () => {
    const home = tempDir();
    const { run } = fakeRun({ stdout: "", stderr: "", code: 0 });
    expect(
      await localMergeDelivery(run).probe({ operation: makeOperation(home), contact: makeContact(null), status: makeStatus(null) }),
    ).toBeNull();
  });
});

test("a delivered PR is not replaced by a closed historical PR on the lane branch", async () => {
  const url = "https://github.com/acme/repo/pull/275";
  const run: Run = async (_command, args) => ({
    code: 0, stderr: "",
    stdout: JSON.stringify(args[2] === url
      ? { state: "OPEN", mergeable: "MERGEABLE", url, statusCheckRollup: [] }
      : { state: "CLOSED", url: "https://github.com/acme/repo/pull/277", statusCheckRollup: [] }),
  });
  const probe = await githubPrDelivery(run).probe({
    operation: makeOperation(tempDir()),
    contact: makeContact("original-branch"),
    status: { delivery: { url, branch: "original-branch" } } as ContactStatus,
  });
  expect(probe).toMatchObject({ url, state: "open", mergeable: "clean" });
});
