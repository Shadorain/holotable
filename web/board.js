// Board view's right column: how the operation is doing, its notes, metrics and wiring.
import { notesPanel } from "./notes.js";
import { el, fmtMs, PHASE_ORDER } from "./ui.js";

function section(title, extra) {
  const box = el("section", "opsec");
  const head = el("div", "group-head");
  head.append(el("span", "", title));
  if (extra) head.append(el("span", "count", extra));
  box.append(head);
  return box;
}

function kv(rows) {
  const grid = el("dl", "kv");
  for (const [k, v, tip, onClick] of rows) {
    const wrap = el("div", onClick ? "kv-link" : "");
    if (tip) wrap.title = tip;
    wrap.append(el("dt", "", k), el("dd", "", v));
    if (onClick) {
      wrap.tabIndex = 0;
      wrap.setAttribute("role", "button");
      wrap.dataset.key = `kv/${k}`;
      wrap.addEventListener("click", onClick);
      wrap.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }
      });
    }
    grid.append(wrap);
  }
  return grid;
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function phaseRows(phaseMs) {
  const names = Object.keys(phaseMs);
  const pos = (p) => {
    const i = PHASE_ORDER.indexOf(p);
    return i === -1 ? PHASE_ORDER.length + names.indexOf(p) : i;
  };
  return names.sort((a, b) => pos(a) - pos(b)).map((p) => [p, fmtMs(phaseMs[p])]);
}

function foldable(id, title, extra) {
  const box = el("details", "opsec fold");
  box.open = localStorage.getItem(`holotable.fold.${id}`) !== "0";
  box.dataset.key = `fold/${id}`;
  box.addEventListener("toggle", () => localStorage.setItem(`holotable.fold.${id}`, box.open ? "1" : "0"));
  const head = el("summary", "group-head");
  head.append(el("span", "", title));
  if (extra) head.append(el("span", "count", extra));
  box.append(head);
  return box;
}

export function renderEvaluationMetrics(root, evaluation, ctx = {}) {
  if (!evaluation) {
    root.append(el("div", "set-note", "Evaluation not recorded"));
    return;
  }
  const e = evaluation;
  const duration = (n) => n === null || n === undefined ? "—" : n === 0 ? "0s" : fmtMs(n);
  const money = (n) => n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
  const sample = (d) => `${duration(d.medianMs)} · n=${d.n}`;
  const u = e.usage;
  root.append(kv([
    ["Deliveries", `${e.deliveredWork} · ${e.throughputPerHour === null ? "—" : e.throughputPerHour.toFixed(2)}/h`, "Landed implement/audit contacts per operation wall hour; not proof of usefulness or correctness."],
    ["Queue wait", sample(e.queue), "Finished queue waits only; intentional parking and dependency waits are included."],
    ["Queued", `${e.queued.n} · oldest ${duration(e.queued.maxMs)}`, "Unlaunched work ages, separate from finished queue latency."],
    ["Delivery", sample(e.delivery), "First observed launch to landing; incomplete work is not counted as zero duration."],
    ["Observed waits", `${duration(e.gateWaitMs)} gate · ${duration(e.offlineMs)} offline`, "Gate, socket and phase intervals overlap. Unreachable does not mean idle."],
    ["Integration", `${e.attempts.conflicts}/${e.attempts.landAttempts}`, "Recorded merge conflicts / recorded land attempts, not a causal concurrency score."],
    ["Usage", u.tokens ? `${fmtTokens(u.tokens.input)} in · ${fmtTokens(u.tokens.output)} out` : "—", u.tokens ? `Reported cache read ${fmtTokens(u.tokens.cacheRead)} · cache write ${fmtTokens(u.tokens.cacheWrite)}; categories are not a provider-independent hit rate.` : "No reported usage."],
    ["Known estimate", `${money(u.knownCostUsd)} · ${u.partial ? "partial" : u.coordinatorSessionAssociated ? "session-associated" : u.basis}`, "Known associated cost estimate, not invoices, subscription billing or exact per-contact attribution."],
  ]));
  const detail = el("details", "fold");
  detail.dataset.key = "evaluation-detail";
  detail.append(el("summary", "group-head", "Evidence and coverage"));
  const rows = [
    ["Timing coverage", `${e.coverage.timed} contacts · ${e.coverage.launched} launched`],
    ["Unfinished", `${e.unfinished.n} · oldest ${duration(e.unfinished.maxMs)}`],
    ["Dependency wait", duration(e.dependencyWaitMs), "Observed dependency blocking only; not historical graph readiness or capacity pressure."],
    ["Connected coordinators", `${e.connectivity.mean === null ? "—" : e.connectivity.mean.toFixed(2)} mean · ${e.connectivity.peak} peak`, "Time-weighted observed connectivity, not worker utilization."],
    ["Worker occupancy", `${duration(e.workers.nonclosedWorkerMs)} worker-time / ${duration(e.workers.coveredMs)} covered`, "Nonclosed workers include reserved/missing workers. This is a sampled proxy, not productive CPU time."],
    ["Launches / relaunches", `${e.attempts.launches} / ${e.attempts.relaunches}`, "Relaunches are repeated launches, not a count of crashes."],
    ["Dispatch reservations", e.fleet.workerAttempts === null ? "—" : `${e.fleet.workerAttempts} · ${e.fleet.redispatches} repeated`, "Dispatch reservations may not launch; resends may reuse the same session."],
    ["Board resend requests", String(e.fleet.boardResendRequests), "Successful board requests only, not all model-initiated retries."],
    ["Usage coverage", `${e.coverage.usageReported}/${e.coverage.launched} contacts · ${u.basis}`],
    ["Missing / unsupported", `${u.missingSources} / ${u.unsupportedWorkers}`],
    ["Unpriced messages", u.unpricedMessages === null ? "unknown" : String(u.unpricedMessages)],
    ["Usage backlog", `${u.backlogBytes} bytes`],
    ["Malformed / resets", `${u.malformedLines} / ${u.resets + e.coverage.counterResets}`],
    ["Known estimate / delivery", money(u.costPerDelivered), "Includes associated observed spend on unfinished work; missing usage and unrelated coordinator-session work affect attribution."],
    ["Clock anomalies", String(e.coverage.clockAnomalies)],
  ];
  if (e.delivery.n >= 10) rows.push(["Delivery p90", duration(e.delivery.p90Ms)]);
  if (e.queue.n >= 10) rows.push(["Queue p90", duration(e.queue.p90Ms)]);
  if (e.quality) {
    const q = e.quality;
    rows.push(
      ["Recorded verification", `${q.recordedPassed} passed · ${q.recordedFailed} failed`, "Producer assertions since instrumentation, not independently verified correctness."],
      ["Repeated failed revision", String(q.repeatedFailedRevision), "Same fingerprint is not necessarily the same root cause."],
      ["Review rounds / failures", `${q.completedRounds} / ${q.reviewFailures}`],
      ["Finding occurrences", `${q.findingOccurrences} · ${q.latestActionable} latest actionable · ${q.latestRejected} rejected`, "Occurrences across rounds are not unique defects; rejections are judgments."],
      ["Accepted repairs", String(q.acceptedRepairs)],
      ["Instrumentation since", q.since],
    );
  } else rows.push(["Quality evidence", "unknown"]);
  detail.append(kv(rows), el("p", "set-note", "Timing is observed elapsed time. Delivery, self-checks and model findings are quality proxies, not external acceptance. No intelligence rule changes execution or approvals."));
  root.append(detail);
  for (const rule of e.recommendations.slice(0, 3)) {
    const box = el("div", "set-note");
    box.append(el("strong","",rule.message),el("p","",`${rule.evidence.numerator}${rule.evidence.denominator===null?"":`/${rule.evidence.denominator}`}${rule.evidence.observedMs===null?"":` · ${duration(rule.evidence.observedMs)} observed`} · ${rule.caveat}`));
    for (const ticket of rule.evidence.contacts) {
      if (ctx.showEvidence) {
        const link = el("button", "linkish", ticket);
        link.type = "button";
        link.addEventListener("click", () => ctx.showEvidence(ticket));
        box.append(link);
      } else box.append(el("span", "mono", `${ticket} `));
    }
    if (rule.evidence.eventIndexes.length) box.append(el("span", "dim", ` · events ${rule.evidence.eventIndexes.map(i => i + 1).join(", ")}`));
    root.append(box);
  }
}

export function renderOps(root, projection, ctx) {
  root.replaceChildren();
  const op = projection.operation;
  const contacts = projection.contacts;

  // Progress first: the one question this column answers at a glance.
  const landed = contacts.filter((c) => c.state === "landed").length;
  const progress = section("Progress", `${landed}/${contacts.length} landed`);
  const meter = el("div", "meter");
  const fill = el("span", "");
  fill.style.width = contacts.length ? `${Math.round((landed / contacts.length) * 100)}%` : "0";
  meter.append(fill);
  progress.append(meter);
  progress.append(
    kv([
      ["Started", String(contacts.filter((c) => c.group === "live" && c.state !== "landed").length), "Launched and not landed yet"],
      ["Queued", String(contacts.filter((c) => c.group === "queue").length), "Waiting to launch (blocked, ready or decisions)"],
      ["Need you", String(contacts.filter((c) => c.attention).length), "Waiting on an operator click or a decision"],
      ["Auto mode", op.auto?.enabled ? "on" : "off", "Open the Operation page to change it", ctx.openOperationPage],
    ]),
  );
  root.append(progress);

  const n = projection.notes;
  const notes = foldable("notes", "Notes", n?.total ? `${n.done}/${n.total}` : "");
  notes.append(notesPanel(op.id, ctx, { compact: true }));
  root.append(notes);

  const s = projection.stats;
  const metrics = foldable("metrics", "Metrics");
  renderEvaluationMetrics(metrics, projection.evaluation, ctx);
  root.append(metrics);
  const phases = phaseRows(s.phaseMs);
  if (phases.length) {
    const box = foldable("phases", "Time in phase");
    box.append(kv(phases.map(([p, v]) => [p, v, `Total time missions spent in ${p}`])));
    root.append(box);
  }

  const wiring = foldable("wiring", "Wiring");
  const ports = el("div", "ports");
  for (const [k, v, tip] of [
    ["tracker", op.tracker, "Where tickets live (Linear, GitHub)"],
    ["fleet", op.fleet, "What runs the work (omp-mission)"],
    ["frontend", op.frontend, "Where worktrees and terminals come from"],
    ["delivery", op.delivery, "How finished work lands"],
    ["pause gates", op.pause ? "on" : "off", "Missions stop at Pause gates for your approval"],
  ]) {
    const chip = el("span", `port${v === "none" ? " off" : ""}`);
    chip.title = tip;
    chip.append(el("span", "", k), el("b", "", v));
    ports.append(chip);
  }
  wiring.append(ports);
  root.append(wiring);
}
