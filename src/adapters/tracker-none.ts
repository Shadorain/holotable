import type { TrackerPort } from "../ports.ts";

export function noneTracker(): TrackerPort {
  return {
    id: "none",
    async sample() {
      return null;
    },
    async search() {
      return null;
    },
  };
}
