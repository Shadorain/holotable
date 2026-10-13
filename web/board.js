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
  const rows = [["Live omp", `${s.omp.current} now · peak ${s.omp.peak}`, "omp sessions this operation has open, and the most at once"]];
  if (s.queueWaitAvgMs !== undefined) rows.push(["Queue wait (avg)", fmtMs(s.queueWaitAvgMs), "How long contacts sat in the queue before launching"]);
  if (s.gateWaitMs !== undefined) rows.push(["Gate wait", fmtMs(s.gateWaitMs), "Time missions spent held at Pause gates waiting for approval"]);
  rows.push(["Land attempts", String(s.landAttempts), "Clicks on Land (and auto lands), clean or conflicting"]);
  if (s.conflictRate !== undefined) rows.push(["Conflict rate", `${Math.round(s.conflictRate * 100)}%`, "Share of land attempts that hit merge conflicts"]);
  if (s.socketDownMs !== undefined) rows.push(["Session downtime", fmtMs(s.socketDownMs), "Time mission sessions were unreachable"]);
  if (s.tokens) {
    const total = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
    rows.push([
      "Tokens",
      fmtTokens(total),
      `Input ${fmtTokens(s.tokens.input)} · output ${fmtTokens(s.tokens.output)} · cache read ${fmtTokens(s.tokens.cacheRead)} · cache write ${fmtTokens(s.tokens.cacheWrite)}\nSummed from each mission's coordinator and worker sessions`,
    ]);
  }
  if (s.costUsd !== undefined && s.costUsd !== null)
    rows.push(["Est. cost", `$${s.costUsd.toFixed(2)}`, "Estimated from the model prices omp reports per message; subscription plans may not be billed this way"]);
  metrics.append(kv(rows));
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
