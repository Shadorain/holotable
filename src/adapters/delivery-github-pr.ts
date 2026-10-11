import type { DeliveryProbe } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type DeliveryPort, type Run } from "../ports.ts";
import { assertIntegrationReady, probeMerge } from "./git-merge.ts";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function checksFrom(rollup: unknown): DeliveryProbe["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let sawPending = false;
  for (const item of rollup) {
    if (!isRecord(item)) {
      sawPending = true;
      continue;
    }
    // CheckRun entries carry conclusion/status; StatusContext entries carry
    // state (SUCCESS/FAILURE/ERROR/PENDING/EXPECTED) and no conclusion.
    if (typeof item.state === "string") {
      if (FAILED.has(item.state)) return "fail";
      if (item.state !== "SUCCESS") sawPending = true;
      continue;
    }
    if (typeof item.conclusion === "string" && FAILED.has(item.conclusion)) return "fail";
    if (item.conclusion == null && item.status !== "COMPLETED") sawPending = true;
  }
  return sawPending ? "pending" : "pass";
}

export function githubPrDelivery(run: Run): DeliveryPort {
  return {
    id: "github-pr",
    async probe(i) {
      const branch = i.status.delivery?.branch ?? i.contact.lane?.branch ?? null;
      if (!branch) return null;
      let result;
      try {
        result = await run(
          "gh",
          ["pr", "view", branch, "--json", "state,mergeable,url,statusCheckRollup"],
          i.operation.integration,
        );
      } catch {
        return null;
      }
      if (result.code !== 0) return null;
      let pr: unknown;
      try {
        pr = JSON.parse(result.stdout);
      } catch {
        return null;
      }
      if (!isRecord(pr) || typeof pr.state !== "string") return null;
      const state = pr.state.toLowerCase();
      if (state !== "open" && state !== "merged" && state !== "closed") return null;
      const mergeable =
        pr.mergeable === "MERGEABLE" ? "clean" : pr.mergeable === "CONFLICTING" ? "conflict" : "unknown";
      return {
        url: typeof pr.url === "string" ? pr.url : null,
        state,
        mergeable,
        checks: checksFrom(pr.statusCheckRollup),
      };
    },
    async land(i) {
      const { operation, contact, sourceBranch, status } = i;
      const integration = operation.integration;
      await assertIntegrationReady(run, integration, operation.base);

      // The PR is identified by the contact's own branch, not sourceBranch:
      // after a conflict the lander passes the resolution branch as source.
      const prBranch = contact.lane?.branch ?? status.delivery?.branch ?? sourceBranch;
      const viewed = await run(
        "gh",
        [
          "pr",
          "view",
          prBranch,
          "--json",
          "state,mergeable,baseRefName,headRefName,headRefOid,url,statusCheckRollup",
        ],
        integration,
      );
      if (viewed.code !== 0)
        throw new PortError(
          "pr-view-failed",
          viewed.stderr.trim() || "gh pr view failed",
        );
      let pr: unknown;
      try {
        pr = JSON.parse(viewed.stdout);
      } catch {
        throw new PortError("pr-view-failed", "gh pr view returned invalid JSON");
      }
      if (!isRecord(pr))
        throw new PortError("pr-view-failed", "gh pr view returned an unexpected shape");
      if (pr.baseRefName !== operation.base)
        throw new PortError(
          "pr-base-mismatch",
          `PR base is ${String(pr.baseRefName)}, expected ${operation.base}`,
        );
      if (checksFrom(pr.statusCheckRollup) === "fail")
        throw new PortError("checks-failing", "a required check failed");
      if (typeof pr.headRefName !== "string" || pr.headRefName.length === 0)
        throw new PortError("pr-view-failed", "gh pr view omitted headRefName");
      const url = typeof pr.url === "string" ? pr.url : "";
      const number = /\/pull\/(\d+)/.exec(url)?.[1];
      if (!number)
        throw new PortError(
          "pr-view-failed",
          "gh pr view url does not name a pull request number",
        );

      if (sourceBranch !== pr.headRefName) {
        // Resolution branch: push it onto the PR head, plain push, no force.
        const pushed = await run(
          "git",
          ["push", "origin", `${sourceBranch}:${pr.headRefName}`],
          integration,
        );
        if (pushed.code !== 0)
          throw new PortError(
            "push-rejected",
            pushed.stderr.trim() || `push of ${sourceBranch} was rejected`,
          );
      }

      const fetched = await run(
        "git",
        ["fetch", "origin", `refs/pull/${number}/head`],
        integration,
      );
      if (fetched.code !== 0)
        throw new PortError(
          "fetch-failed",
          fetched.stderr.trim() || `git fetch refs/pull/${number}/head failed`,
        );
      const sha = await run(
        "git",
        ["rev-parse", "FETCH_HEAD"],
        integration,
      );
      const deliveredSha =
        sha.code === 0 && sha.stdout.trim().length > 0
          ? sha.stdout.trim()
          : typeof pr.headRefOid === "string"
            ? pr.headRefOid
            : "";

      const probeResult = await probeMerge(run, integration, "FETCH_HEAD");
      if (probeResult.outcome === "conflict")
        return {
          outcome: "conflict",
          paths: probeResult.paths,
          deliveredSha,
          baseSha: probeResult.baseSha,
        };

      const merged = await run(
        "gh",
        ["pr", "merge", number, "--merge"],
        integration,
      );
      if (merged.code !== 0)
        throw new PortError(
          "gh-merge-failed",
          merged.stderr.trim() || "gh pr merge failed",
        );
      // Best-effort: sync the integration worktree to the merged base. A
      // failure here is not fatal to the land.
      try {
        const fetchBase = await run(
          "git",
          ["fetch", "origin", operation.base],
          integration,
        );
        if (fetchBase.code === 0)
          await run(
            "git",
            ["merge", "--ff-only", `origin/${operation.base}`],
            integration,
          );
      } catch {
        // logged by the caller's event stream; nothing to do here
      }
      return { outcome: "landed", via: "pr" };
    },
  };
}
