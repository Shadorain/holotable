import { isRecord } from "../core/validate.ts";
import type { Run, TrackerHit, TrackerPort } from "../ports.ts";
import { readLinearWorkspace } from "./linear-account.ts";

// `lin issues get` returns state and identifier, not `url`. The issue URL is the
// workspace key plus the identifier — never a GitHub pull request built from the number.
const IDENTIFIER = /^[A-Z][A-Z0-9]+-\d+$/;
const URL_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const PULL_URL = /\/pull\/\d+(?:[/?#]|$)/i;

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || PULL_URL.test(value)) return null;
  return value;
}

function identifierOf(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

async function loadWorkspaceKey(run: Run, cwd: string, workspace?: string): Promise<string | null> {
  try {
    const result = await run("lin", ["me", "--json", ...(workspace ? ["--workspace", workspace] : [])], cwd);
    if (result.code !== 0) return null;
    const payload: unknown = JSON.parse(result.stdout);
    if (!isRecord(payload) || !isRecord(payload.viewer)) return null;
    const organization = payload.viewer.organization;
    const key = isRecord(organization) ? organization.urlKey : undefined;
    return typeof key === "string" && URL_KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}


export function linearTracker(run: Run): TrackerPort {
  const keys = new Map<string, Promise<string | null>>();
  const workspaceKey = (cwd: string, workspace: string | undefined): Promise<string | null> => {
    if (!workspace) return loadWorkspaceKey(run, cwd);
    const identity = JSON.stringify([cwd, workspace ?? null]);
    let promise = keys.get(identity);
    if (!promise) {
      promise = loadWorkspaceKey(run, cwd, workspace).then((key) => {
        if (!key) keys.delete(identity);
        return key;
      });
      keys.set(identity, promise);
    }
    return promise;
  };

  return {
    id: "linear",
    async sample(ticket, cwd) {
      try {
        const workspace = await readLinearWorkspace(cwd, run);
        const result = await run("lin", ["issues", "get", ticket.toUpperCase(), "--json", ...(workspace ? ["--workspace", workspace] : [])], cwd);
        if (result.code !== 0) return null;
        const payload: unknown = JSON.parse(result.stdout);
        if (!isRecord(payload) || !isRecord(payload.issue)) return null;
        const issue = payload.issue;
        const state = isRecord(issue.state) ? issue.state.name : undefined;
        if (typeof state !== "string" || state.length === 0) return null;
        const identifier = identifierOf(issue.identifier) ?? identifierOf(ticket.toUpperCase());
        let url = httpUrl(issue.url);
        if (!url && identifier) {
          const key = await workspaceKey(cwd, workspace);
          if (key) url = `https://linear.app/${key}/issue/${identifier}`;
        }
        return { state, url };
      } catch {
        return null;
      }
    },
    async search(query, cwd, limit) {
      try {
        const workspace = await readLinearWorkspace(cwd, run);
        const result = await run("lin", ["search", query, "--json", "--limit", String(limit), ...(workspace ? ["--workspace", workspace] : [])], cwd);
        if (result.code !== 0) return null;
        const payload: unknown = JSON.parse(result.stdout);
        if (!isRecord(payload) || !Array.isArray(payload.issues)) return null;
        const hits: TrackerHit[] = [];
        let needKey = false;
        for (const issue of payload.issues) {
          if (!isRecord(issue) || typeof issue.identifier !== "string" || typeof issue.title !== "string") continue;
          const state = isRecord(issue.state) && typeof issue.state.name === "string" ? issue.state.name : null;
          const identifier = identifierOf(issue.identifier);
          const direct = httpUrl(issue.url);
          if (!direct && identifier) needKey = true;
          hits.push({ ticket: issue.identifier, title: issue.title, state, url: direct });
        }
        if (needKey) {
          const key = await workspaceKey(cwd, workspace);
          if (key) {
            for (const hit of hits) {
              if (hit.url) continue;
              const identifier = identifierOf(hit.ticket);
              if (identifier) hit.url = `https://linear.app/${key}/issue/${identifier}`;
            }
          }
        }
        return hits;
      } catch {
        return null;
      }
    },
  };
}
