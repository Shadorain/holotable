---
name: holotable
description: Set up and manage Holotable operations from repository goals and tracker work.
disable-model-invocation: true
---

# Holotable

Holotable coordinates a campaign of omp-mission sessions; it launches and watches missions, never runs them.

Paths below are relative to this skill's directory, not the working repository:

- Read [concepts and safety](../../README.md#concepts) first.
- Use [the reference](../../docs/reference.md) for CLI commands and seed files, and [the guide](../../docs/guide.md) for operation planning and board actions. Use `holotable` (or `bun <plugin-root>/bin/holotable.ts` if not on PATH); never edit board storage directly.
- Inspect the target repo, tracker and existing projects/operations before creating anything. Turn the goal into scoped contacts with acceptance criteria and dependencies; record unknowns and externally owned work as blockers, not agent implementation tasks.
- Creating an operation does not authorize launching, enabling auto mode, approving plans or merging. Follow [the safety model](../../README.md#safety-model); enable automation only when explicitly requested.
- If asked to clean up old worktrees, inspect ownership, uncommitted changes and unmerged work first. Preserve anything unsafe to remove; never force-delete it.
