import type { DeliveryProbe } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type DeliveryPort, type Run } from "../ports.ts";
import { assertIntegrationReady, branchInBase, probeMerge } from "./git-merge.ts";

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

function failedChecks(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) return [];
  const names = rollup.filter(isRecord).flatMap((item) => {
    const failed = typeof item.state === "string" ? FAILED.has(item.state) : typeof item.conclusion === "string" && FAILED.has(item.conclusion);
    const name = typeof item.name === "string" ? item.name : typeof item.context === "string" ? item.context : "unnamed check";
    return failed ? [name] : [];
  });
  return [...new Set(names)];
}

export function githubPrDelivery(run: Run): DeliveryPort {
  return {
    id: "github-pr",
    async probe(i) {
      const branch = i.status.delivery?.branch ?? i.contact.lane?.branch ?? null;
      const selector = i.status.delivery?.url ?? branch;
      if (!selector) return null;
      let result;
      try {
        result = await run(
          "gh",
          ["pr", "view", selector, "--json", "state,mergeable,url,statusCheckRollup"],
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
      const failing = failedChecks(pr.statusCheckRollup);
      return {
        url: typeof pr.url === "string" ? pr.url : null,
        state,
        mergeable,
        checks: checksFrom(pr.statusCheckRollup),
        ...(failing.length ? { failing } : {}),
      };
    },
    async verifyMerged(i) {
      // GitHub's own record is the authority: a squash merge rewrites the commits, so ancestry cannot answer it.
      let reason: string | null = null;
      try {
        const viewed = await run(
          "gh",
          ["pr", "view", i.url ?? i.branch, "--json", "state,baseRefName,url,number"],
          i.operation.integration,
        );
        if (viewed.code === 0) {
          const pr: unknown = JSON.parse(viewed.stdout);
          if (isRecord(pr) && typeof pr.state === "string") {
            const label = typeof pr.number === "number" ? `PR #${pr.number}` : "the PR";
            if (pr.state === "MERGED") {
              if (pr.baseRefName === i.operation.base) return { merged: true, detail: `${label} merged into ${i.operation.base}` };
              return { merged: false, reason: `${label} merged into ${String(pr.baseRefName)}, not ${i.operation.base}` };
            }
            reason = pr.state === "OPEN" ? `${label} is still open` : `${label} was closed without merging`;
          }
        }
      } catch { /* no usable PR answer: fall through to the git check */ }
      const git = await branchInBase(run, i.operation.integration, i.operation.base, i.branch);
      if (git.merged || reason === null) return git;
      return { merged: false, reason: `${reason}; ${git.reason}` };
    },
    async land(i) {
      const { operation, contact, sourceBranch, status } = i;
      const integration = operation.integration;
      await assertIntegrationReady(run, integration, operation.base, sourceBranch);

      // A branch can have several historical PRs; the mission's delivered URL identifies this result.
      const prSelector = status.delivery?.url ?? contact.lane?.branch ?? status.delivery?.branch ?? sourceBranch;
      const viewed = await run(
        "gh",
        [
          "pr",
          "view",
          prSelector,
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
      const checks = i.ignoreChecks === true ? "pass" : checksFrom(pr.statusCheckRollup);
      if (checks === "fail") {
        const failing = failedChecks(pr.statusCheckRollup);
        throw new PortError("checks-failing", failing.length ? `failing check: ${failing.join(", ")}` : "a required check failed");
      }
      if (checks === "pending") throw new PortError("checks-pending", "checks still running");
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

      // Repo merge-method settings govern the flag: only-allowed methods on GitHub
      // reject the wrong flag ("Merge commits are not allowed") on a mergeable PR.
      let method = "--merge";
      const allowed = await run(
        "gh",
        ["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed"],
        integration,
      );
      if (allowed.code === 0) {
        try {
          const methods = JSON.parse(allowed.stdout) as Record<string, boolean>;
          if (methods.squashMergeAllowed) method = "--squash";
          else if (methods.rebaseMergeAllowed) method = "--rebase";
        } catch { /* unparseable settings: keep the merge default */ }
      }

      const merged = await run(
        "gh",
        ["pr", "merge", number, method],
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
