import { homedir } from "node:os";
import { join } from "node:path";

export function holotableHome(): string {
  return (
    process.env.OMP_HOLOTABLE_HOME || join(homedir(), ".omp", "agent", "holotable")
  );
}

// Same env order as omp-mission/src/config.ts so statuses and sockets line up.
export function agentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ||
    process.env.OMP_AGENT_DIR ||
    join(homedir(), ".omp", "agent")
  );
}

export function operationsDir(home: string): string {
  return join(home, "operations");
}

export function operationDir(home: string, id: string): string {
  return join(operationsDir(home), id);
}

export function projectsDir(home: string): string {
  return join(home, "projects");
}

export function projectDir(home: string, id: string): string {
  return join(projectsDir(home), id);
}

export function projectFile(home: string, id: string): string {
  return join(projectDir(home, id), "project.json");
}

export function draftsDir(home: string): string {
  return join(home, "drafts");
}

const DRAFT_ID = /^draft-[0-9a-f]{8}$/;
export const isDraftId = (id: string): boolean => DRAFT_ID.test(id);

/** Draft ids become directory names; anything else is a path escape. */
export function assertDraftId(id: string): void {
  if (!DRAFT_ID.test(id)) throw new Error(`Invalid draft id "${id}"`);
}

export function draftDir(home: string, id: string): string {
  return join(draftsDir(home), id);
}
export function archiveDir(home: string): string {
  return join(home, "archive");
}
