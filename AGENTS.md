# holotable

OMP extension: a campaign board over `omp-mission`. It launches and watches missions. It does not run them.

Read `README.md` and `docs/architecture.md` before changing behavior. `PLAN.md` lists only what is not built. `bun run demo` serves the real page over simulated ports.

## Name

Repo and extension: `holotable`. Command: `/holotable`. An operation is one campaign inside it. Do not add a second command named `/operation`.

## Rules

- This process never attaches a mission and never calls `control()`. Operator clicks go through the child session's socket. The operation model does not get approve, continue, or land.
- Never route around Pause gates, resume hold, or the ownership lock. The one automatic `continue` is Recovery, switched on per operation by the operator: it sends `continue` over the socket like a click, only to board-launched sessions (`ctl` set), never when `verify` is `failed`, and never approves gates or plans.
- Launch through the operation's frontend port. The Orca frontend uses `orca worktree create`; frontends that do not manage worktrees use `git-workspaces.ts`, the only `git worktree add` caller. Mission bind is reuse-only on that path.
- Land on the integration worktree. Never merge inside a mission checkout. A conflict becomes a new local-graph mission. It is not a second copy of the ticket.
- Do not close Linear issues or merge PRs except from an operator click or auto mode the operator switched on for that operation.
- Queue stays visible. Blocked work does not launch and does not disappear.
- The board edits and refines a pending plan through the control socket. Plan approval is sent only when the session advertises `plan-approve` in `status.actions` (OMP's `resolvePlanReview`; unreleased as of 18.10.3): by the operator's **Approve plan** click or the opt-in `auto.plans`. Otherwise it stays in the mission pane (`docs/omp-plan-approval.md`).
- Auto decide is opt-in per operation: a decision contact takes its recommended option, or an omp pane decides and records its reasoning. The operator can change any decision; the board itself never picks an answer.
- Stats are append-only events. Do not store a second copy of mission JSON.
- Model fallback and session routing stay in OMP. This board may show the cap. It does not pick a model.
- Tests use an isolated `PI_CODING_AGENT_DIR`. Never touch `~/.omp/agent/missions` or the live `mission.json`.
- Herdr config is authored on daedalus only. Never hand-edit `config.toml` on a Mac.

## Commands and layout

Bun + TypeScript, no build step. `web/` is plain HTML/CSS/JS. Commands: `bun test`, `bun run typecheck`, `bun run demo`.

```
src/core/      pure: no node:* imports, no process.env, no Date.now() (clock is an argument), no I/O
src/store/     the only code that touches $OMP_HOLOTABLE_HOME
src/adapters/  the only code that spawns processes or opens sockets; spawns go through the injected Run
src/runtime/   watcher, launcher, actions, lander, auto mode, cleanup
src/extension.ts  wiring only
```

Behavior changes update `README.md` and the affected doc in the same commit. One commit per slice, conventional commits, never push.

## Reference docs

|Doc|Covers|
|---|---|
|`README.md`|use, commands, settings, safety|
|`docs/architecture.md`|layers, ports, data flow, invariants, events|
|`PLAN.md`|what is not built yet|
|`docs/contract.md`|status file and control socket wire contract|
|`docs/omp-plan-approval.md`|what auto-approving plans waits on (OMP API, omp-mission op)|
