---
name: holotable
description: Set up and manage Holotable operations from repository goals and tracker work.
disable-model-invocation: true
---

# Holotable

Holotable supports two execution modes:

- **Missions** uses board-launched omp-mission panes and the mission workflow.
- **Agent-managed** keeps the board passive. The main OMP session coordinates native task subagents and explicitly reports their lifecycle; the board does not infer task status, launch or recover workers.

Paths below are relative to this skill's directory, not the working repository:

- Read [concepts and safety](../../README.md#concepts) first.
- Use [the reference](../../docs/reference.md) for CLI commands and seed files, and [the guide](../../docs/guide.md) for planning and board actions. Use `holotable` (or `bun <plugin-root>/bin/holotable.ts` if not on PATH); never edit board storage directly.
- Inspect the target repo, tracker and existing projects/operations before creating anything. Turn the goal into scoped contacts with acceptance criteria and dependencies; record unknowns and externally owned work as blockers, not implementation tasks.
- Choose execution explicitly: `missions` for omp-mission panes, or `agent` for native task subagents. Creating an operation does not authorize launching workers, enabling mission automation, approving plans or merging.
- Follow [the safety model](../../README.md#safety-model). If asked to clean up worktrees, inspect ownership, uncommitted changes and unmerged work first. Preserve anything unsafe to remove; never force-delete it.

## Agent-managed workflow

Use the main OMP session as the coordinator; do not start `/mission` panes. On OMP, `holotable_work` injects the current session id as coordinator ownership. Do not invent a coordinator id. Claim before starting work:

1. Select/create the operation with `--execution agent`. Read `holotable_state`; queue or update contacts with `holotable_queue`, respecting dependencies and existing assignments. A decision contact is answered with `holotable_work` action `decide`, its offered `choice`, and a concise `summary`; it does not get a worker.
2. Claim with `holotable_work` action `claim`. If another coordinator owns it, do not take over or infer that it died; ask an operator to release it. Ownership release is explicit, retains worker assignments, and does not stop native task jobs.
3. Launch native task subagents from the main session for ready contacts. Keep an exact ticket-to-task-job-id mapping; report the actual task job id as `worker` (a callsign alone is not an identity). Report each worker's state explicitly with `holotable_work` action `report`: `assigned`, `running`, `blocked`, `verifying`, `complete` or `integrated`, plus a concise summary. Include verification and commit when applicable.
4. Report blockers and failures as `blocked` with their reason. Do not mark a failed or unknown worker successful, and never infer worker completion from a task-tool return or from process/session death. The coordinator must report lifecycle state; if status is uncertain, say so in the summary and do not report `complete`.
5. `complete` means only that the worker says its task is done; it is not landed and does not unblock dependents. The coordinator independently verifies the changes, resolves conflicts, integrates them, then reports `integrated` with the resulting commit and verification evidence. Report `integrated` only after that real integration verification.

The board records reported progress but does not launch, monitor, retry or terminate native task jobs. Closing or aborting an operation also cannot stop them; coordinate or stop every job separately before handoff or archival. Never treat an operation's archived/closed state as proof that workers stopped.
