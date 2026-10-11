# Auto-approving plans: what is waiting on OMP

The Operation page has an **Approve plans** switch (`auto.plans`). The board side is built; nothing happens yet because OMP gives extensions no way to resolve plan mode's review dialog.

## 1. OMP (`@oh-my-pi/pi-coding-agent`)

Plan approval lives in interactive mode (`handlePlanApproval` → `showPlanReview` → `#approvePlan`). Extensions can read and edit the plan file and send feedback, but cannot approve or exit plan mode. Needed on `ExtensionContext`:

```ts
planReview?: {
  pending(): { planFilePath: string; title: string } | null;
  approve(options?: { compactBeforeExecute?: boolean; preserveContext?: boolean }): Promise<boolean>;
  refine(feedback: string): Promise<void>;
};
```

plus an event when a plan becomes ready for review (e.g. `plan_review_requested { planFilePath, title }`). `approve` should behave exactly like the overlay's approve choices (plan file on disk, closes the overlay if open, main session only).

## 2. omp-mission (`src/holotable.ts`, `src/extension.ts`)

- New operator op `plan-approve` on the control socket, with `args.revision` (the `status.plan.revision` the board saw). Reject with `stale` when the plan changed since; otherwise call `ctx.planReview.approve()` and let the normal plan-approved path start the mission.
- Advertise it: while a plan is pending and `ctx.planReview` exists, `status.actions` includes `"plan-approve"` (today `actions` is empty while pending). Feature-detect `ctx.planReview` so older OMP keeps working.
- Add `plan-approve` to `OPERATOR_OPS` and the docs (README "Holotable board", `docs/architecture.md` status file and socket).

## 3. Board (done)

- `auto.plans` setting, history credit, Operation page switch with a "waiting on OMP" note while no session advertises the op.
- `runtime/auto.ts`: with auto mode and `auto.plans` on, a contact at `hold: "plan-approval"`, owner live, `ctl` set and `"plan-approve"` in `status.actions` gets `plan-approve` with `args.revision`, once per revision, credited to auto mode.
- `projection.operation.auto.plansSupported` turns true as soon as one live session advertises the op, which removes the waiting note.

After 1 and 2 land: bump omp-mission, then try it on the playground with a real pane (the playground simulates its own panes and never advertises the op).
