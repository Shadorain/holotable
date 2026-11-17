import { describe, expect, test } from "bun:test";
import { detectRepo } from "../../src/adapters/detector.ts";
import { parseHostSetups } from "../../src/adapters/orca-exec.ts";
import { normalizeRemoteUrl, resolveRemotePlacement } from "../../src/adapters/placement.ts";
import { validateOperation, validateOperationDoc } from "../../src/core/validate-operation.ts";
import { validateProject } from "../../src/core/validate-project.ts";
import type { Run } from "../../src/ports.ts";

const base = () => ({
  v: 1,
  id: "lab",
  name: "Lab",
  repo: "/repo",
  base: "main",
  integration: "/repo",
  pause: false,
  tracker: "none",
  fleet: "omp-mission",
  frontend: "orca",
  delivery: "local-merge",
  zones: [],
  contacts: [],
  createdAt: "2026-01-02T03:04:05.000Z",
});

describe("placement validation", () => {
  test("a legacy operation without host stays valid and local", () => {
    const op = validateOperation(base());
    expect(op.host).toBeUndefined();
    expect(op.hostSetup).toBeUndefined();
  });

  test("an operation inherits a remote project host, and explicit local drops the setup pin", () => {
    const project = validateProject({
      ...base(),
      id: "proj",
      host: "ssh:box",
      hostSetup: "setup-1",
    });
    const inherited = validateOperationDoc({ ...base(), project: "proj", repo: undefined, base: undefined, integration: undefined, host: undefined }, "op.json", project);
    expect(inherited.operation.host).toBe("ssh:box");
    expect(inherited.operation.hostSetup).toBe("setup-1");
    expect(inherited.inherited).toContain("host");

    const local = validateOperationDoc({ ...base(), project: "proj", host: "local" }, "op.json", project);
    expect(local.operation.host).toBe("local");
    expect(local.operation.hostSetup).toBeUndefined();
    expect(local.operation.repo).toBe("/repo");
  });

  test("hostSetup without a remote host is rejected", () => {
    expect(() => validateOperation({ ...base(), hostSetup: "setup-1" })).toThrow(/hostSetup requires/);
    expect(() => validateProject({ ...base(), hostSetup: "setup-1" })).toThrow(/hostSetup requires/);
  });
});

describe("remote setup parsing", () => {
  test("reads upstream setupState and repoId, and ignores other hosts", () => {
    const rows = parseHostSetups(
      {
        setups: [
          { id: "s1", projectId: "github:acme/app", repoId: "repo-1", hostId: "ssh:box", path: "/srv/app", setupState: "ready" },
          { id: "s2", projectId: "github:acme/app", hostId: "local", path: "/home/me/app", state: "ready" },
        ],
      },
      "ssh:box",
    );
    expect(rows).toEqual([
      { id: "s1", projectId: "github:acme/app", repoId: "repo-1", hostId: "ssh:box", path: "/srv/app", state: "ready" },
    ]);
  });

  test("normalizeRemoteUrl collapses scheme and .git", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/app.git")).toBe(normalizeRemoteUrl("https://github.com/acme/app"));
    expect(normalizeRemoteUrl("not a url")).toBeNull();
  });
});

describe("detectRepo remote plane", () => {
  test("does not realpath locally or call orca repo list when a canonicalizer and setup row are supplied", async () => {
    const calls: string[] = [];
    const run: Run = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "rev-parse") return { stdout: "/srv/app\n", stderr: "", code: 0 };
      if (command === "git" && args.includes("get-url")) return { stdout: "https://github.com/acme/app.git\n", stderr: "", code: 0 };
      if (command === "git") return { stdout: "main\n", stderr: "", code: 0 };
      throw new Error(`unexpected ${command}`);
    };
    const detected = await detectRepo("/srv/app", run, [{ path: "/srv/app", displayName: "App" }], {
      canonicalize: async (path) => {
        calls.push(`canon ${path}`);
        return path;
      },
      probeRun: async (command) => {
        calls.push(`probe ${command}`);
        return { stdout: "", stderr: "", code: 1 };
      },
    });
    expect(detected.fields.integration).toBe("/srv/app");
    expect(detected.fields.frontend).toBe("orca");
    expect(calls.some((c) => c.startsWith("orca"))).toBe(false);
    expect(calls).toContain("canon /srv/app");
    expect(calls.some((c) => c.startsWith("probe gh"))).toBe(true);
  });
});

describe("resolveRemotePlacement", () => {
  test("rejects an ambiguous path and a missing setup without guessing", async () => {
    const run: Run = async (command, args) => {
      if (command === "orca" && args[0] === "project") {
        return {
          stdout: JSON.stringify({
            setups: [
              { id: "a", projectId: "p", hostId: "ssh:box", path: "/srv/app", setupState: "ready" },
              { id: "b", projectId: "p", hostId: "ssh:box", path: "/srv/app", setupState: "ready" },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    await expect(resolveRemotePlacement(run, "/board", { host: "ssh:box", repo: "/srv/app" })).rejects.toThrow(/hostSetup/);
    await expect(resolveRemotePlacement(run, "/board", { host: "ssh:box", hostSetup: "missing" })).rejects.toThrow(/does not exist/);
  });
});
