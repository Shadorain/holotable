# Approving plans from the board

The board can approve a mission's pending plan through the mission's control socket: the card shows **Approve plan** when the session advertises it, and the Operation page's **Approve plans** switch (`auto.plans`) lets auto mode send it.

## What exists

OMP merged an extension API for the interactive plan review (oh-my-pi PR #14250, on `main`; **not in a release yet**: 18.10.3 does not have it). On `ExtensionContext` (both optional):

```ts
resolvePlanReview?(reviewId: string, choice: "execute" | "compact" | "keep" | "refine" | "save", input?: { feedback?: string }): boolean;
getPendingPlanReview?(): PlanReviewRequestedEvent | undefined;
```

plus the events `plan_review_requested` (review id, title, plan path and content, the choices) and `plan_review_resolved`. The first answer wins; the terminal overlay stays live.

## Contract

- omp-mission opens the review's `reviewId` from those events (and `getPendingPlanReview()` for a review that opened before the handler was bound) and serves a `plan-approve` operator op on the control socket with `args.revision` (the `status.plan.revision` the board saw). A revision that is not the current one answers `stale`.
- It resolves the review with `compact`, the choice the operator makes by hand ("Approve and compact context"). It never uses `execute`: that choice clears the session, which drops the pending-mission entries, and the mission would be lost.
- `status.actions` includes `"plan-approve"` only while a plan is pending **and** a review is open **and** the running OMP has `resolvePlanReview`. Older OMP keeps the old behavior: approve in the pane.
- The board never computes this: it renders and sends what `status.actions` says.

## Board side

- `auto.plans` setting, history credit (`plan approved`), the Operation page switch with a "waiting on OMP" note while no live session advertises the op.
- `runtime/auto.ts`: with auto mode and `auto.plans` on, a contact at `hold: "plan-approval"` with a live owner, `ctl` set and `"plan-approve"` in `status.actions` gets `plan-approve` with `args.revision`, once per revision, credited to auto mode.
- `projection.operation.auto.plansSupported` turns true as soon as one live session advertises the op, which removes the waiting note.

## Until OMP releases it

Sessions on 18.10.3 never advertise the op, so plans are approved in the pane. To try it early, run an OMP built from `main`, then launch a mission from the board and watch the card.
