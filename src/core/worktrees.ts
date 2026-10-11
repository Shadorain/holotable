// Where holotable's own `git worktree add` puts lanes (herdr, custom). Orca places
// worktrees itself, in its project's worktree folder, so none of this applies there.

export const DEFAULT_WORKTREE_ROOT = "{repo}-holotable-{name}";

/** Why a template is unusable, or null when it is fine. */
export function worktreeRootProblem(template: string): string | null {
  if (template.length === 0 || template.length > 500) return "must be 1-500 characters";
  if (!template.includes("{name}")) return "must contain {name} so every lane gets its own folder";
  if (!(template.startsWith("/") || template.startsWith("~/") || template.startsWith("{repo}")))
    return "must start with /, ~/ or {repo}";
  const unknown = template.match(/\{(?!repo\}|repoName\}|name\})[^}]*\}/);
  if (unknown) return `unknown placeholder ${unknown[0]}; use {repo}, {repoName} or {name}`;
  if (template.split("/").includes("..")) return "must not contain ..";
  return null;
}

export function expandWorktreeRoot(template: string, repo: string, name: string, homeDir: string): string {
  const repoName = repo.replace(/\/+$/, "").split("/").pop() ?? repo;
  const home = homeDir.replace(/\/+$/, "");
  const withHome = template.startsWith("~/") ? `${home}/${template.slice(2)}` : template;
  return withHome.replaceAll("{repo}", repo).replaceAll("{repoName}", repoName).replaceAll("{name}", name);
}
