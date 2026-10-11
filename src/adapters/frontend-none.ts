import { PortError, type FrontendPort } from "../ports.ts";

const NO_FRONTEND = "No frontend configured for this operation";

export function noneFrontend(): FrontendPort {
  return {
    id: "none",
    async ensureRepo() {},
    async createWorkspace() {
      throw new PortError("no-frontend", NO_FRONTEND);
    },
    async openTerminal() {
      throw new PortError("no-frontend", NO_FRONTEND);
    },
    async listTerminals() {
      return null;
    },
    async focus() {
      throw new PortError("no-frontend", NO_FRONTEND);
    },
    async close() {
      throw new PortError("no-frontend", NO_FRONTEND);
    },
    async removeWorkspace() {
      throw new PortError("no-frontend", NO_FRONTEND);
    },
  };
}
