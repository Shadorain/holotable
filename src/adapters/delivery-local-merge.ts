import { assertIntegrationReady, branchInBase, mergeBranch } from "./git-merge.ts";
import type { DeliveryPort, Run } from "../ports.ts";

export function localMergeDelivery(run: Run): DeliveryPort {
  return {
    id: "local-merge",
    async probe(i) {
      const branch = i.status.delivery?.branch ?? i.contact.lane?.branch ?? null;
      if (!branch) return null;
      let result;
      try {
        result = await run(
          "git",
          ["merge-base", "--is-ancestor", branch, i.operation.base],
          i.operation.integration,
        );
      } catch {
        return null;
      }
      if (result.code !== 0 && result.code !== 1) return null;
      return {
        url: null,
        state: result.code === 0 ? "merged" : "open",
        mergeable: "unknown",
        checks: "none",
      };
    },
    async verifyMerged(i) {
      return branchInBase(run, i.operation.integration, i.operation.base, i.branch, true);
    },
    async land(i) {
      await assertIntegrationReady(run, i.operation.integration, i.operation.base, i.sourceBranch);
      const outcome = await mergeBranch(run, i.operation.integration, i.sourceBranch);
      if (outcome.outcome === "conflict") return outcome;
      return { outcome: "landed", via: "merge" };
    },
  };
}
