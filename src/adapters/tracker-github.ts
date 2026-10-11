import { isRecord } from "../core/validate.ts";
import type { Run, TrackerHit, TrackerPort } from "../ports.ts";

// Tickets are `owner/repo#N` or bare `#N`; a bare number runs gh in the
// contact's cwd so the checkout's remote resolves the repository.
export function githubTracker(run: Run): TrackerPort {
  return {
    id: "github",
    async sample(ticket, cwd) {
      const match = /^(?:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<number>\d+)$/.exec(ticket);
      if (!match?.groups) return null;
      const args = ["issue", "view", match.groups.number];
      if (match.groups.repo) args.push("--repo", match.groups.repo);
      args.push("--json", "state,url");
      try {
        const result = await run("gh", args, cwd);
        if (result.code !== 0) return null;
        const issue: unknown = JSON.parse(result.stdout);
        if (!isRecord(issue) || typeof issue.state !== "string" || issue.state.length === 0)
          return null;
        return {
          state: issue.state.toLowerCase(),
          url: typeof issue.url === "string" ? issue.url : null,
        };
      } catch {
        return null;
      }
    },
    async search(query, cwd, limit) {
      try {
        const result = await run(
          "gh",
          ["issue", "list", "--search", query, "--json", "number,title,state,url", "--limit", String(limit)],
          cwd,
        );
        if (result.code !== 0) return null;
        const rows: unknown = JSON.parse(result.stdout);
        if (!Array.isArray(rows)) return null;
        const hits: TrackerHit[] = [];
        for (const row of rows) {
          if (!isRecord(row) || typeof row.number !== "number" || typeof row.title !== "string") continue;
          // `#N` is the same ticket form `gh issue view` resolves from this repo.
          hits.push({
            ticket: `#${row.number}`,
            title: row.title,
            state: typeof row.state === "string" && row.state.length ? row.state.toLowerCase() : null,
            url: typeof row.url === "string" ? row.url : null,
          });
        }
        return hits;
      } catch {
        return null;
      }
    },
  };
}
