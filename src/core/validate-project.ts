import { worktreeRootProblem } from "./worktrees.ts";
import { ID_RE } from "./validate-operation.ts";
import { DELIVERIES, FLEETS, FRONTENDS, TRACKERS, type Project } from "./types.ts";
import { enumPicker, invalidAt, isRecord } from "./validate.ts";

/** project.json: one repo plus the defaults operations on it inherit. */
export function validateProject(value: unknown, path = "project.json"): Project {
  const fail = invalidAt("project", path);
  if (!isRecord(value)) return fail("expected a JSON object");
  if (value.v !== 1) return fail("v must be 1");
  if (typeof value.id !== "string" || !ID_RE.test(value.id))
    return fail("id must match ^[a-z0-9][a-z0-9-]{0,47}$");
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 80)
    return fail("name must be 1-80 characters");
  if (typeof value.repo !== "string" || !value.repo.startsWith("/"))
    return fail("repo must be an absolute path");
  if (
    typeof value.base !== "string" ||
    value.base.length < 1 ||
    value.base.length > 200 ||
    /\s/.test(value.base)
  )
    return fail("base must be 1-200 characters with no whitespace");
  if (typeof value.integration !== "string" || !value.integration.startsWith("/"))
    return fail("integration must be an absolute path");
  if (typeof value.pause !== "boolean") return fail("pause must be a boolean");
  const enumOf = enumPicker(fail);
  const tracker = enumOf("tracker", value.tracker, TRACKERS);
  const fleet = enumOf("fleet", value.fleet, FLEETS);
  const frontend = enumOf("frontend", value.frontend, FRONTENDS);
  const delivery = enumOf("delivery", value.delivery, DELIVERIES);
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))
    return fail("createdAt must be an ISO-8601 timestamp");
  if (value.worktreeRoot !== undefined) {
    if (typeof value.worktreeRoot !== "string") return fail("worktreeRoot must be a string");
    const problem = worktreeRootProblem(value.worktreeRoot);
    if (problem) return fail(`worktreeRoot ${problem}`);
  }
  const project: Project = {
    v: 1,
    id: value.id,
    name: value.name,
    repo: value.repo,
    base: value.base,
    integration: value.integration,
    pause: value.pause,
    tracker,
    fleet,
    frontend,
    delivery,
    createdAt: value.createdAt,
    ...(typeof value.worktreeRoot === "string" ? { worktreeRoot: value.worktreeRoot } : {}),
  };
  return project;
}
