import { PortError, type FleetPort } from "../ports.ts";

export function noneFleet(): FleetPort {
  return {
    id: "none",
    launch() {
      throw new PortError("no-fleet", "No fleet configured for this operation");
    },
    async read() {
      return null;
    },
    async ping() {
      return false;
    },
    async control() {
      throw new PortError("no-fleet", "No fleet configured for this operation");
    },
    async readPlan() {
      throw new PortError("no-fleet", "No fleet configured for this operation");
    },
  };
}
