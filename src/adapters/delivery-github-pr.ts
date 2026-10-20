import type { DeliveryProbe } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type DeliveryPort, type Run } from "../ports.ts";
import { assertIntegrationReady, branchInBase, probeMerge } from "./git-merge.ts";

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** How long a fresh PR head with no workflow runs and no checks may still be waiting for CI to register. */
const CHECKS_REGISTER_MS = 20 * 60_000;

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
    async publish(i) {
      const { operation, contact, branch } = i;
      const pushed = await run("git", ["push", "origin", `${branch}:${branch}`], operation.integration);
      if (pushed.code !== 0) throw new PortError("push-rejected", pushed.stderr.trim() || `push of ${branch} was rejected`);
      const title = `${contact.ticket}: ${contact.title ?? "audit changes"}`;
      const body = `${contact.description ?? ""}\n\nOpened by holotable: the ${contact.kind} mission for ${contact.ticket} finished with commits that are not in \`${operation.base}\` and delivered no PR.`.trim();
      const created = await run("gh", ["pr", "create", "--base", operation.base, "--head", branch, "--title", title, "--body", body], operation.integration);
      if (created.code !== 0) throw new PortError("pr-create-failed", created.stderr.trim() || `gh pr create for ${branch} failed`);
      const url = created.stdout.trim().split("\n").reverse().find((line) => /\/pull\/\d+/.test(line));
      if (!url) throw new PortError("pr-create-failed", "gh pr create printed no pull request URL");
      return { url: url.trim() };
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

      // A head GitHub just updated has no check runs yet, which reads as "no CI". Its workflow runs exist first;
      // a head younger than CHECKS_REGISTER_MS with neither is still waiting for CI to start.
      if (checks === "none" && deliveredSha) {
        const runs = await run("gh", ["run", "list", "--commit", deliveredSha, "--json", "status"], integration);
        let active = false;
        let any = false;
        if (runs.code === 0) {
          try {
            const rows = JSON.parse(runs.stdout) as Array<{ status?: string }>;
            any = rows.length > 0;
            active = rows.some((row) => row.status !== "completed");
          } catch { /* unparseable: fall back to the commit age */ }
        }
        const committed = await run("git", ["log", "-1", "--format=%ct", deliveredSha], integration);
        const age = Date.now() - Number(committed.stdout.trim()) * 1000;
        if (active || (!any && committed.code === 0 && age < CHECKS_REGISTER_MS))
          throw new PortError("checks-pending", `checks not started yet on ${deliveredSha.slice(0, 7)}`);
      }

      // Judge conflicts against the base as GitHub has it, not a stale local checkout. Best effort, like the post-land sync.
      const syncBase = await run("git", ["fetch", "origin", operation.base], integration);
      if (syncBase.code === 0) await run("git", ["merge", "--ff-only", `origin/${operation.base}`], integration);

      const probeResult = await probeMerge(run, integration, deliveredSha || "FETCH_HEAD");
      if (probeResult.outcome === "conflict")
        return {
          outcome: "conflict",
          paths: probeResult.paths,
          deliveredSha,
          baseSha: probeResult.baseSha,
        };

      // Green CI on a PR built against an older base says nothing about the merge: two green PRs can combine into a red base.
      // A PR behind the base gets the base merged in on GitHub, which reruns its checks; Land waits for them.
      if (i.ignoreChecks !== true && syncBase.code === 0 && deliveredSha) {
        const current = await run("git", ["merge-base", "--is-ancestor", `origin/${operation.base}`, deliveredSha], integration);
        if (current.code === 1) {
          const updated = await run(
            "gh",
            ["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${number}/update-branch`, "-f", `expected_head_sha=${deliveredSha}`],
            integration,
          );
          if (updated.code !== 0)
            throw new PortError("update-branch-failed", updated.stderr.trim() || `could not update PR #${number} from ${operation.base}`);
          throw new PortError("branch-updated", `PR #${number} was behind ${operation.base}; merged ${operation.base} into it on GitHub. Land waits for its checks on the combined code.`);
        }
        if (current.code !== 0)
          throw new PortError("fetch-failed", current.stderr.trim() || `cannot compare PR #${number} with origin/${operation.base}`);
      }

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
