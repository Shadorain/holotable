import { PortError, type DeliveryPort } from "../ports.ts";

export function noneDelivery(): DeliveryPort {
  return {
    id: "none",
    async probe() {
      return null;
    },
    async land() {
      throw new PortError("no-delivery", "No delivery configured for this operation");
    },
  };
}
