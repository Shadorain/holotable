// Internal Affairs synthesis: turns deterministic evaluation + rollup evidence into a
// ranked docket of findings, each with the measured stat, named culprits, and a concrete
// operator fix (deep link into the board, or an exact command to run). Pure JS — no
// network, no model calls. Consumed by intel.js (rendering) and intel-review.js (prompt).

const pct = (n, d) => d > 0 ? n / d : null;
const share = (v, total) => total > 0 ? Math.round(v / total * 100) : null;

export const SEVERITY_ORDER = ["critical", "warning", "watch", "coverage"];

// Per-rule playbooks. Each returns { title, severity, stats, fixes } given the rule's
// evidence plus the whole evaluation snapshot. Fixes are {label, text, kind} where kind
// is "link" (board deep link), "cmd" (copyable command) or "note" (advice only).
const OPERATION_PLAYBOOKS = {
  "relaunch-churn": (rule, e, ctx) => ({
    title: "Session instability: pane churn",
    severity: "critical",
    stats: `${rule.evidence.numerator} of ${rule.evidence.denominator} launches were relaunches (${Math.round(pct(rule.evidence.numerator, rule.evidence.denominator) * 100)}%)` + (e.offlineMs ? ` · ${ctx.duration(e.offlineMs)} of unreachable time` : ""),
    detail: "Panes are being restarted far past routine relaunch. Relaunches include deliberate operator relaunches, so this does not prove pane death — but the pattern still costs review and execution progress.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Enable auto-recovery", text: `/holotable use ${ctx.opId} && /holotable set recover on`, kind: "cmd" },
      { label: "Reduce live pane cap if this host is resource-bound", text: "/holotable config cap 4", kind: "cmd" },
      { label: "Open worst contact history on the board", text: `board:${ctx.opId}:${rule.evidence.contacts[0] ?? ""}`, kind: "link" },
    ],
  }),
  "review-retries": (rule, e, ctx) => ({
    title: `Review churn: ${rule.evidence.numerator} failed rounds`,
    severity: "critical",
    stats: e.quality && (e.quality.completedRounds + e.quality.reviewFailures) > 0
      ? `${rule.evidence.numerator} failure${rule.evidence.numerator === 1 ? "" : "s"} across ${e.quality.completedRounds + e.quality.reviewFailures} review operations (${Math.round(e.quality.reviewFailures / (e.quality.completedRounds + e.quality.reviewFailures) * 100)}% failure rate)` + (e.fleet.repairLinks ? ` · ${e.fleet.repairLinks} repair links opened` : "")
      : `${rule.evidence.numerator} review round failures recorded`,
    detail: "Failed review operations are not completed rounds and not proof of defects — but retries at this rate dominate the review phase. Check reviewer model quota and contact scope before accepting the churn as normal.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Check subscription quota for reviewer models", text: "Settings → AI & Models → Load subscription quotas (on the board, header gear). Exhausted pools fail review rounds, not slow them.", kind: "note" },
      { label: "Open worst review contact", text: `board:${ctx.opId}:${rule.evidence.contacts[0] ?? ""}`, kind: "link" },
      { label: "Lower reasoning effort for new panes", text: "/holotable config ai.thinking low", kind: "cmd" },
    ],
  }),
  "repeat-verification": (rule, _e, ctx) => ({
    title: `Verification repeats: ${rule.evidence.numerator} failures share a fingerprint`,
    severity: "critical",
    stats: rule.evidence.denominator != null ? `${rule.evidence.numerator} of ${rule.evidence.denominator} recorded failures repeated` : `${rule.evidence.numerator} consecutive records share a fingerprint`,
    detail: "A shared fingerprint is not proof of the same root cause, but repair is cycling without changing the outcome. Inspect the actual failing check before more repair rounds burn tokens.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Read the failing check on the contact's history", text: `board:${ctx.opId}:${rule.evidence.contacts[0] ?? ""}`, kind: "link" },
      { label: "If the check is genuinely unfixable in this scope, exclude it in the contact description before the next repair round", text: "Tighten the contact description (Board → contact card → Details) with acceptance criteria that omit the failing path, or split the ticket.", kind: "note" },
    ],
  }),
  "integration-conflicts": (rule, _e, ctx) => ({
    title: `Merge conflicts on ${Math.round(pct(rule.evidence.numerator, rule.evidence.denominator) * 100)}% of land attempts`,
    severity: "critical",
    stats: `${rule.evidence.numerator} conflict${rule.evidence.numerator === 1 ? "" : "s"} across ${rule.evidence.denominator} land attempts`,
    detail: "Observed conflicts do not prove concurrency caused them — contacts may genuinely edit shared paths. But every conflict opens a resolver mission that costs a full extra pass.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Serialize conflicting contacts", text: "Add blockedBy edges so shared-path contacts land one at a time (Plan map → contact card → waits for).", kind: "note" },
      { label: "Reduce live pane cap", text: "/holotable config cap 4", kind: "cmd" },
    ],
  }),
  "delivery-wait": (rule, e, ctx) => ({
    title: "Completed missions sit ready-to-land",
    severity: "warning",
    stats: rule.evidence.observedMs != null ? `${ctx.duration(rule.evidence.observedMs)} median ready→land across ${rule.evidence.numerator} deliveries` : `${rule.evidence.numerator} deliveries waited`,
    detail: "Finished work that cannot land gains the operation nothing. When auto mode is off, every land is a manual click; when on, something downstream (checks, conflicts, integration checkout) is blocking.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Enable auto mode with landing", text: `/holotable use ${ctx.opId} && /holotable set auto on`, kind: "cmd" },
      { label: "Open longest-waiting delivered contact", text: `board:${ctx.opId}:${rule.evidence.contacts[0] ?? ""}`, kind: "link" },
    ],
  }),
  "dependency-wait": (rule, _e, ctx) => ({
    title: "Dependency blocking dominates queue time",
    severity: "warning",
    // Blocked time is summed per contact before launch, so it can exceed launched lifetime; a percent would read >100%.
    stats: `${ctx.duration(rule.evidence.numerator)} blocked before launch vs ${ctx.duration(rule.evidence.denominator)} launched mission time`,
    detail: "Contacts sat blocked longer than missions actually ran. Unblocking the chain head unblocks every successor; widening the fleet does not.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Open the dependency map to see the chain", text: `map:${ctx.opId}`, kind: "link" },
      { label: "Enable auto launch so unblocked contacts start without a manual click", text: `/holotable use ${ctx.opId} && /holotable set auto.launch on`, kind: "cmd" },
    ],
  }),
  "approval-wait": (rule, _e, ctx) => ({
    title: "Approval gates pause delivery",
    severity: "watch",
    stats: `${rule.evidence.numerator} of ${rule.evidence.denominator} timed contacts held at gates · ${ctx.duration(rule.evidence.observedMs)} total`,
    detail: "Hold time overlaps phase time and is not exclusive human response time — but if gates wait on you, batch approvals or let the board answer them itself.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Enable auto plan approval (opts into plan-approve on the socket)", text: `/holotable use ${ctx.opId} && /holotable set auto.plans on`, kind: "cmd" },
      { label: "New missions run without Pause gates", text: `/holotable use ${ctx.opId} && /holotable set pause false`, kind: "cmd" },
    ],
  }),
  "phase-cost": (rule, _e, ctx) => ({
    title: "Review phase dominates attributed spend",
    severity: "warning",
    stats: `${ctx.number(rule.evidence.numerator)} review-phase tokens · ${Math.round(pct(rule.evidence.numerator, rule.evidence.denominator) * 100)}% of attributed usage`,
    detail: "Review-phase tokens include coordinator-session spend during review, not just the reviewers — but when review dominates the token ledger, narrower scope or a cheaper review model is the biggest lever.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "Lower reasoning effort for new panes", text: "/holotable config ai.thinking low", kind: "cmd" },
      { label: "Tighten contact descriptions so reviews scope smaller diffs", text: "Board → contact card → Details → description: name the files/subsystems to touch.", kind: "note" },
    ],
  }),
  "usage-coverage": (rule, e, ctx) => ({
    title: "Accounting coverage is partial",
    severity: "coverage",
    stats: `${rule.evidence.numerator} of ${rule.evidence.denominator} launched contacts reported usage${e.coverage.legacyUsage ? ` · ${e.coverage.legacyUsage} contacts on legacy accounting` : ""}${e.usage.coordinatorSessionAssociated ? " · includes whole coordinator session" : ""}`,
    detail: "Known spend is a session-associated estimate with missing and legacy sources; do not read it as an invoice or per-ticket cost. Costs shown are real money; the attribution is what is approximate.",
    culprits: rule.evidence.contacts,
    fixes: [
      { label: "New missions report scoped usage automatically — this mostly affects older missions already in flight", text: "No action needed beyond reading spend as an estimate. Legacy contacts keep their own baselines until they end.", kind: "note" },
    ],
  }),
};

// Synthesized cases that don't map 1:1 to a threshold rule — computed directly from the
// evaluation so the docket catches what the rules miss.
function synthesizedCases(e, ctx) {
  const cases = [];
  const phaseTotal = Object.values(e.phaseMs).reduce((a, b) => a + b, 0);
  const reviewRepairMs = (e.phaseMs.review ?? 0) + (e.phaseMs.repair ?? 0);
  const reworkShare = share(reviewRepairMs, phaseTotal);
  const executeShare = share(e.phaseMs.execute ?? 0, phaseTotal);
  const rrTokens = (e.usage.byPhase?.review?.tokens ?? 0) + (e.usage.byPhase?.repair?.tokens ?? 0);
  const rrCost = (e.usage.byPhase?.review?.costUsd ?? 0) + (e.usage.byPhase?.repair?.costUsd ?? 0);
  const alreadySurfaced = e.recommendations.some(r => r.id === "phase-cost" || r.id === "review-retries");
  if (phaseTotal >= 3_600_000 && reworkShare !== null && reworkShare >= 50 && !alreadySurfaced) {
    cases.push({
      id: "rework-dominates",
      impact: { ms: reviewRepairMs, usd: rrCost > 0 ? rrCost : null, scoreMs: reviewRepairMs },
      title: `Review and repair absorbed ${reworkShare}% of recorded phase time`,
      severity: "critical",
      stats: `${ctx.duration(reviewRepairMs)} in review+repair vs ${ctx.duration(e.phaseMs.execute ?? 0)} executing` + (rrCost > 0 ? ` · ${ctx.money(rrCost)} attributed` : ` · ${ctx.number(rrTokens)} tokens attributed`),
      detail: "Execution is not the bottleneck — verification is. More throughput gains come from cutting review cycles and repair rounds than from adding workers.",
      culprits: [],
      fixes: [
        { label: "Lower reasoning effort for new panes", text: "/holotable config ai.thinking low", kind: "cmd" },
        { label: "Give contacts narrower acceptance criteria", text: "Board → contact card → Details → description: bounded scope means bounded review.", kind: "note" },
      ],
    });
  }
  if (e.queued.n >= 5 && e.queued.maxMs !== null && e.queued.maxMs >= 3_600_000 && e.connectivity.mean !== null && e.connectivity.mean < e.queued.n / 3) {
    cases.push({
      id: "starved-queue",
      impact: { ms: e.queued.totalMs, usd: null, scoreMs: e.queued.totalMs },
      title: `${e.queued.n} contacts queued, ~${number0(e.connectivity.mean)} missions live`,
      severity: "watch",
      stats: `Oldest queued ${ctx.duration(e.queued.maxMs)} · ${e.unfinished.n} launched-not-delivered`,
      detail: "The queue is starving the fleet: either launch capacity is capped too low, auto launch is off, or dependency chains are parked. Widen only if the machine has headroom.",
      culprits: [],
      fixes: [
        { label: "Enable auto launch with a live cap", text: `/holotable use ${ctx.opId} && /holotable set auto.launch on && /holotable set auto.maxLive 8`, kind: "cmd" },
        { label: "Open the dependency map for parked chains", text: `map:${ctx.opId}`, kind: "link" },
      ],
    });
  }
  return cases;
}
const number0 = n => Math.round(n * 10) / 10;

/** A `/holotable set <field> on` fix is pointless when that setting is already on for the operation. */
function alreadyOn(fix, auto) {
  if (!auto || fix.kind !== "cmd") return false;
  const fields = [...fix.text.matchAll(/set (auto(?:\.\w+)?) on/g)].map(m => m[1]);
  return fields.length > 0 && fields.every(f => (f === "auto" ? auto.enabled : auto[f.slice(5)]) === true);
}

/**
 * Build the Internal Affairs docket for one evaluated operation/archive. Cases carry the rule's `impact`
 * (what it puts at stake) and rank by it; evaluations archived before impact ranking rank by severity.
 * `ctx.auto` is the operation's current auto settings when known (open operations).
 */
export function operationDocket(e, ctx) {
  const cases = e.recommendations
    .map(rule => ({ id: rule.id, impact: rule.impact ?? null, ...OPERATION_PLAYBOOKS[rule.id]?.(rule, e, ctx) }))
    .filter(c => c.title);
  cases.push(...synthesizedCases(e, ctx));
  for (const c of cases) if (c.fixes) c.fixes = c.fixes.filter(fix => !alreadyOn(fix, ctx.auto));
  if (e.recommendations.some(rule => rule.impact)) cases.sort((a, b) => (b.impact?.scoreMs ?? 0) - (a.impact?.scoreMs ?? 0));
  else cases.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return cases.slice(0, 6);
}

/** Build the Internal Affairs docket for the fleet rollup. */
export function fleetDocket(rollup, ctx) {
  const t = rollup.totals;
  const cases = [];
  const find = (list, id) => list.find(m => m.id === id);
  const relaunch = find(rollup.failures, "launches");
  const reviewFail = find(rollup.failures, "review-failures");
  const conflicts = find(rollup.failures, "conflicts");
  const repairs = find(rollup.failures, "repairs");
  const depWait = find(rollup.waits, "dependency");
  const offline = find(rollup.waits, "offline");
  const ready = find(rollup.waits, "ready");
  const reviewPhase = find(rollup.phases, "review");
  const repairPhase = find(rollup.phases, "repair");
  const executePhase = find(rollup.phases, "execute");
  const phaseTotal = rollup.phases.reduce((a, m) => a + m.value, 0);

  if (relaunch && relaunch.rate !== null && relaunch.rate >= 0.4)
    cases.push({
      id: "fleet-relaunch", severity: "critical",
      title: `Session instability across the fleet: ${Math.round(relaunch.rate * 100)}% of launches were relaunches`,
      stats: `${relaunch.value} relaunches in ${relaunch.operations} operation${relaunch.operations === 1 ? "" : "s"}` + (offline ? ` · ${ctx.duration(offline.value)} unreachable` : ""),
      detail: "Restarts at this rate are systemic — resource pressure, quota drops or unrecovered disconnects, not per-mission bugs.",
      fixes: [
        { label: "Enable auto-recovery on affected operations", text: "/holotable use <op> && /holotable set recover on", kind: "cmd" },
        { label: "Reduce live pane cap", text: "/holotable config cap 4", kind: "cmd" },
      ],
    });
  const rrMs = (reviewPhase?.value ?? 0) + (repairPhase?.value ?? 0);
  if (phaseTotal > 0 && rrMs / phaseTotal >= 0.5) {
    const rrCost = (rollup.costs.find(c => c.id === "review")?.value ?? 0) + (rollup.costs.find(c => c.id === "repair")?.value ?? 0);
    cases.push({
      id: "fleet-rework", severity: "critical",
      title: `Review and repair absorbed ${Math.round(rrMs / phaseTotal * 100)}% of fleet phase time`,
      stats: `${ctx.duration(rrMs)} review+repair vs ${ctx.duration(executePhase?.value ?? 0)} executing` + (rrCost > 0 ? ` · ${ctx.money(rrCost)} attributed` : "") + (repairs ? ` · ${repairs.value} repairs accepted` : ""),
      detail: "Verification work outweighs implementation. The lever is fewer review cycles and tighter scope per ticket, not more workers.",
      fixes: [
        { label: "Lower reasoning effort for new panes", text: "/holotable config ai.thinking low", kind: "cmd" },
        { label: "Split large contacts before launch", text: "Bounded tickets produce bounded reviews; seed descriptions with file/subsystem scope.", kind: "note" },
      ],
    });
  }
  if (reviewFail && reviewFail.rate !== null && reviewFail.rate >= 0.3)
    cases.push({
      id: "fleet-review-fail", severity: "critical",
      title: `${Math.round(reviewFail.rate * 100)}% of review operations failed`,
      stats: `${reviewFail.value} failure${reviewFail.value === 1 ? "" : "s"} across ${reviewFail.denominator} review operation${reviewFail.denominator === 1 ? "" : "s"} · ${reviewFail.operations} operation${reviewFail.operations === 1 ? "" : "s"}`,
      detail: "Review retries are burning rounds without completing them. Check reviewer model capacity and contact scope before widening review concurrency.",
      fixes: [
        { label: "Check reviewer model quota", text: "Settings → AI & Models → Load subscription quotas.", kind: "note" },
        { label: "Lower review-model reasoning", text: "/holotable config ai.thinking low", kind: "cmd" },
      ],
    });
  if (depWait && depWait.rate !== null && depWait.rate >= 0.5)
    cases.push({
      id: "fleet-dependency", severity: "warning",
      title: `Dependency blocking is the largest recorded wait (${Math.round(depWait.rate * 100)}% of wait time)`,
      stats: `${ctx.duration(depWait.value)} blocked before launch · ${depWait.operations} operation${depWait.operations === 1 ? "" : "s"}`,
      detail: "Blocked-before-launch time exceeds every other wait class combined in affected operations. Unblock chain heads; adding capacity does not move parked work.",
      fixes: [
        { label: "Enable auto launch on affected operations", text: "/holotable use <op> && /holotable set auto.launch on", kind: "cmd" },
      ],
    });
  if (ready && ready.rate !== null && ready.rate >= 0.04 && ready.value >= 3_600_000)
    cases.push({
      id: "fleet-delivery", severity: "warning",
      title: `${ctx.duration(ready.value)} of ready work waited to land`,
      stats: `${Math.round(ready.rate * 100)}% of recorded wait time · ${ready.operations} operation${ready.operations === 1 ? "" : "s"}`,
      detail: "Delivered-but-unlanded work earns nothing. If auto land is off these are manual clicks; if on, checks or integration are blocking.",
      fixes: [
        { label: "Enable auto mode with landing", text: "/holotable use <op> && /holotable set auto on", kind: "cmd" },
      ],
    });
  if (conflicts && conflicts.rate !== null && conflicts.rate >= 0.3)
    cases.push({
      id: "fleet-conflicts", severity: "warning",
      title: `${Math.round(conflicts.rate * 100)}% of land attempts hit merge conflicts`,
      stats: `${conflicts.value} conflict${conflicts.value === 1 ? "" : "s"} across ${conflicts.denominator} land attempts · ${conflicts.operations} operation${conflicts.operations === 1 ? "" : "s"}`,
      detail: "Conflicts spawn resolver missions at full mission cost. Serialize shared-path work rather than resolving collisions after the fact.",
      fixes: [
        { label: "Serialize shared-path contacts with blockedBy", text: "Plan map → contact card → waits for: order contacts that edit the same files.", kind: "note" },
        { label: "Reduce live pane cap", text: "/holotable config cap 4", kind: "cmd" },
      ],
    });
  if (t.usagePartial)
    cases.push({
      id: "fleet-accounting", severity: "coverage",
      title: "Fleet cost figures are partial estimates",
      stats: `${ctx.money(t.knownCostUsd)} known spend${t.drafts?.costUsd != null ? ` + ${ctx.money(t.drafts.costUsd)} board drafts` : ""} · coverage incomplete`,
      detail: "Read costs as session-associated estimates, not invoices: missing sources, legacy accounting and coordinator-session association all widen the true figure.",
      fixes: [{ label: "Coverage detail", text: "Partial coverage is normal for operations with older or restarted missions; scoped usage improves on new work.", kind: "note" }],
    });
  const rank = c => SEVERITY_ORDER.indexOf(c.severity);
  cases.sort((a, b) => rank(a) - rank(b));
  return cases.slice(0, 6);
}
