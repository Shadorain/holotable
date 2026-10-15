import { PortError, type DeliveryPort, type Run } from "../ports.ts";
import { branchInBase } from "./git-merge.ts";

export function noneDelivery(run: Run): DeliveryPort {
  return {
    id: "none",
    async probe() {
      return null;
    },
    async verifyMerged(i) {
      // Nothing here merges: the operator does, outside the board. Only a real merge in the base counts.
      return branchInBase(run, i.operation.integration, i.operation.base, i.branch);
    },
    async land() {
      throw new PortError("no-delivery", "No delivery configured for this operation");
    },
  };
}
