import { isRecord } from "../core/validate.ts";
import type { Run, TrackerHit, TrackerPort } from "../ports.ts";

export function linearTracker(run: Run): TrackerPort {
  return {
    id: "linear",
    async sample(ticket, cwd) {
      try {
        const result = await run("lin", ["issues", "get", ticket.toUpperCase(), "--json"], cwd);
        if (result.code !== 0) return null;
        const payload: unknown = JSON.parse(result.stdout);
        if (!isRecord(payload) || !isRecord(payload.issue)) return null;
        const issue = payload.issue;
        const state = isRecord(issue.state) ? issue.state.name : undefined;
        if (typeof state !== "string" || state.length === 0) return null;
        return { state, url: typeof issue.url === "string" ? issue.url : null };
      } catch {
        return null;
      }
    },
    async search(query, cwd, limit) {
      try {
        const result = await run("lin", ["search", query, "--json", "--limit", String(limit)], cwd);
        if (result.code !== 0) return null;
        const payload: unknown = JSON.parse(result.stdout);
        if (!isRecord(payload) || !Array.isArray(payload.issues)) return null;
        // `lin search` returns no issue URL; the board has no link to offer.
        const hits: TrackerHit[] = [];
        for (const issue of payload.issues) {
          if (!isRecord(issue) || typeof issue.identifier !== "string" || typeof issue.title !== "string") continue;
          const state = isRecord(issue.state) && typeof issue.state.name === "string" ? issue.state.name : null;
          hits.push({ ticket: issue.identifier, title: issue.title, state, url: null });
        }
        return hits;
      } catch {
        return null;
      }
    },
  };
}
