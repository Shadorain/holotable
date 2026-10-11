# Plan

Campaign command center across repositories. A project defines a repo and shared wiring; an operation is one campaign with a queue, live `/mission` contacts and a history. Table, Board and Plan are views of the same operation.

## Not this layer

- Bead graphs, worker prompts, verification, review judgment, repair acceptance. Those stay in the child.
- Model fallback, role routing, provider quota substitution. Show "cap N omp" and a quota block if status says so. Do not choose a model.
- Auto-close. Closing an operation stays an operator click.
- Parsing private mission JSON or importing `controller.ts`.

## Safety

Operator click is the approval, same as typing the slash command in the child. The click handler is the only caller of mutating socket ops. A model turn in the holotable session may refresh, explain, and propose a launch. It may not send approve, continue, mode, land, or conflict-open.

If the owner is offline, status is the last snapshot and mutations fail `owner-offline`. Do not attach to "help".

Pause, resume hold, and plan approval still apply inside the child. The socket runs the same `control()` the slash command runs. Illegal phase transitions still fail.

## Status

The generic build (slices 0-11) has landed. This file keeps only what is not built; the rest lives in:

|Topic|Where|
|---|---|
|use, commands, settings, tools, safety|`README.md`|
|layers, ports, data flow, invariants, events, contact states|`docs/architecture.md`|
|mission status file, control socket, launch recipe|`docs/contract.md`|
|tests and smokes|`docs/testing.md`|

## Improvements, not v1

- Opt-in notifications when a gate arms, a socket dies, or a land conflicts.
- Dashed blocker lines on the table from a queued pin to its live blocker.
- Drag or edit zone angles, saved on the operation. v1 uses fixed angles.
- Timeline scrubber over `events.jsonl`.
- Cross-operation load chart. v1 is a single number.
- Search across contacts.
- Stale-owner row after the socket has been down past a threshold.
- Export events as JSONL. No PDF.
- Sound, 3D table, galaxy map, admiral override. No.

## Waiting on OMP

- Auto-approve plans: the switch and board logic exist; OMP needs an extension API for plan review and omp-mission a `plan-approve` socket op. See `docs/omp-plan-approval.md`.
