# Approving plans from the board

OMP 18.10.4 exposes native plan review to extensions. Use an updated omp-mission and relaunch older mission panes to load the integration; refreshing the board does not update a running OMP process.

## Native lifecycle

`ExtensionContext` exposes `openPlanReview(): Promise<boolean>`, `getPendingPlanReview()` and `resolvePlanReview(reviewId, choice, input?)`. Typed `plan_review_requested` and `plan_review_resolved` events report the review, its plan file, available choices and closure. `openPlanReview` does not interrupt streaming or compaction and keeps an existing review open.

omp-mission opens an idle pending plan's native review once per written revision. It does not reopen an unchanged plan after dismissal or interrupt queued work. It reads the actual native review's `planFilePath` rather than assuming the agent used the suggested slug. A previously opened review is recovered through `getPendingPlanReview`.

## Operator actions

- **Approve plan** sends `plan-approve` over the child session's control socket, with the displayed `status.plan.revision`. A changed file answers `stale`.
- Approval resolves `compact`, preserving the pending mission for OMP's approved-plan execution turn. `execute` clears the session and is not used by this integration.
- **Edit** saves the plan atomically with stale-base checks. Native approval reads the current plan file unless the operator has separately edited it inside OMP's overlay.
- **Refine** resolves the open native review's `refine` choice with feedback. If that review closes first, the request rejects rather than queuing duplicate feedback. Older runtimes without an open native review retain the feedback-prompt path.
- `status.actions` advertises `plan-approve` only for a pending plan with an answerable review and an enabled compact choice. The board renders this capability, never invents it.
- Otherwise **Approve in pane** focuses the child session. Use `/plan-review`; older OMP processes need updating and relaunching.

## Automatic approval

`auto.plans` is off by default. With auto mode and this switch on, `runtime/auto.ts` sends the same revision-bound `plan-approve` request to live board-launched sessions advertising it, once per revision, credited to auto mode. A lack of an open review is not proof that the runtime is unsupported, so the Operation page no longer shows the obsolete “waiting on OMP” release warning.

Pause gates, ownership and resume holds remain independent. Recovery never approves a plan. Session model routing stays in OMP; the board does not choose an execution tier.
