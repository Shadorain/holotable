import { el, errorText, fetchJson, fmtMs } from "./ui.js";
import { buildReviewPrompt } from "./intel-review.js";
import { operationDocket, fleetDocket } from "./intel-brief.js";

const duration = n => n == null ? "Unknown" : n === 0 ? "0s" : fmtMs(n);
const money = n => n == null ? "Unknown" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
// Counts are whole numbers; averages and rates keep at most one decimal; shares are whole percents.
const number = n => n == null ? "Unknown" : Math.round(n).toLocaleString();
const decimal = n => n == null ? "Unknown" : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const percent = r => `${Math.round(r * 100)}%`;
const sample = d => d.n ? `${duration(d.medianMs)} median · ${d.n} measured` : "None measured";
const date = value => new Date(value).toLocaleString();
const opIdOf = source => source.startsWith("op:") ? source.slice(3) : "";
function severityBadge(s) {
  const label = { critical: "ACTION", warning: "WATCH", watch: "WATCH", coverage: "COVERAGE" }[s] ?? s.toUpperCase();
  return el("span", `ia-badge ia-${s}`, label);
}
function fixCard(fix, open) {
  const row = el("div", "ia-fix");
  const label = el("span", "ia-fix-label", fix.label);
  row.append(label);
  if (fix.kind === "cmd") {
    const cmd = el("button", "ia-cmd", fix.text);
    cmd.type = "button";
    cmd.title = "Copy command";
    cmd.addEventListener("click", () => {
      navigator.clipboard?.writeText(fix.text).then(
        () => { cmd.textContent = "Copied"; setTimeout(() => { cmd.textContent = fix.text; }, 1500); },
        () => { cmd.textContent = "Copy failed — select and copy manually"; },
      );
    });
    row.append(cmd);
  } else if (fix.kind === "link") {
    const link = el("button", "btn small", "Open on board →");
    link.type = "button";
    link.addEventListener("click", () => open(fix.text));
    row.append(link);
  } else {
    row.append(el("p", "intel-muted ia-note", fix.text));
  }
  return row;
}
function caseCard(c, open, opId) {
  const card = el("article", `ia-case ia-${c.severity}`);
  const head = el("div", "ia-case-head");
  head.append(severityBadge(c.severity), el("h3", "", c.title));
  card.append(head, el("p", "ia-stats", c.stats), el("p", "intel-muted", c.detail));
  if (c.culprits?.length) {
    const chips = el("div", "ia-chips");
    chips.append(el("span", "ia-chips-label", "Worst offenders"));
    for (const ticket of c.culprits.slice(0, 3)) {
      const chip = el("button", "ia-chip", ticket);
      chip.type = "button";
      chip.title = `Open ${ticket} on the board`;
      chip.addEventListener("click", () => open(`board:${opId}:${ticket}`));
      chips.append(chip);
    }
    card.append(chips);
  }
  const fixes = el("div", "ia-fixes");
  for (const fix of c.fixes ?? []) fixes.append(fixCard(fix, open));
  if (fixes.childElementCount) card.append(fixes);
  return card;
}
function docketSection(cases, open, opId) {
  const section = el("section", "ia-docket");
  const head = el("div", "ia-docket-head");
  head.append(el("h2", "intel-section-title", "Internal affairs"), el("span", "intel-muted", `${cases.length} open finding${cases.length === 1 ? "" : "s"}`));
  section.append(head);
  if (!cases.length) {
    section.append(el("p", "intel-muted", "No findings above threshold. Cases appear here when relaunches, failed checks, reviews, conflicts or waits cross a rule threshold; small samples limit conclusions."));
    return section;
  }
  const list = el("ol", "ia-list");
  for (const c of cases) {
    const item = el("li");
    item.append(caseCard(c, open, opId));
    list.append(item);
  }
  section.append(list);
  return section;
}
// Compact phase ledger: one row per phase with time, spend and tokens — the "big detail"
// that used to live inside three separate folded tables.
function phaseLedger(e) {
  const phases = new Set([...Object.keys(e.phaseMs), ...Object.keys(e.usage.byPhase ?? {})]);
  const totalMs = Object.values(e.phaseMs).reduce((a, b) => a + b, 0);
  const totalCost = Object.values(e.usage.byPhase ?? {}).reduce((a, v) => a + (v.costUsd ?? 0), 0);
  const totalTokens = Object.values(e.usage.byPhase ?? {}).reduce((a, v) => a + v.tokens, 0);
  const rows = [...phases].map(phase => ({
    phase,
    ms: e.phaseMs[phase] ?? 0,
    cost: e.usage.byPhase?.[phase]?.costUsd ?? 0,
    tokens: e.usage.byPhase?.[phase]?.tokens ?? 0,
  })).sort((a, b) => b.ms - a.ms);
  if (!rows.length) return null;
  const table = el("table", "intel-metric-table ia-ledger");
  const head = el("tr");
  for (const col of ["Phase", "Time", "Time share", "Spend", "Spend share", "Tokens"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    const bar = el("div", "ia-bar");
    const fill = el("div", "ia-bar-fill");
    fill.style.width = `${totalMs ? Math.min(100, r.ms / totalMs * 100) : 0}%`;
    bar.append(fill);
    const timeCell = el("td", "ia-bar-cell");
    timeCell.append(bar, el("span", "", duration(r.ms)));
    row.append(
      el("td", "", r.phase),
      timeCell,
      el("td", "", totalMs ? percent(r.ms / totalMs) : "—"),
      el("td", "", r.cost ? money(r.cost) : "—"),
      el("td", "", totalCost && r.cost ? percent(r.cost / totalCost) : "—"),
      el("td", "", r.tokens ? number(r.tokens) : "—"),
    );
    body.append(row);
  }
  table.append(body);
  const box = el("section", "ia-ledger");
  box.append(el("h3", "intel-section-title", "Where recorded time and spend went"));
  box.append(tableContainer(table, "Phase ledger: time, spend and tokens"));
  if (e.usage.partial) box.append(el("p", "intel-muted", "Spend is a session-associated estimate with partial coverage; phase attribution assigns each usage-sample delta to the phase active when the sample arrived."));
  return box;
}
const queryFor = value => {
  const colon = value.indexOf(":");
  return new URLSearchParams([[value.slice(0, colon), value.slice(colon + 1)]]).toString();
};
function facts(rows) {
  const grid = el("dl", "intel-facts");
  for (const [label, value, note] of rows) {
    const item = el("div");
    item.append(el("dt", "", label), el("dd", "", String(value)));
    if (note) item.append(el("p", "", note));
    grid.append(item);
  }
  return grid;
}
function headline(label, value, note) {
  const card = el("dl", "intel-headline");
  card.append(el("dt", "", label), el("dd", "", value), el("p", "", note));
  return card;
}
function tableContainer(table, label) {
  const container = el("div", "intel-table-scroll");
  container.tabIndex = 0;
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", label);
  container.append(table);
  return container;
}
function metricRows(list, render, share = false) {
  const table = el("table", "intel-metric-table");
  const head = el("tr");
  for (const col of ["Class", "Recorded", share ? "Recorded share" : "Rate", "Affected ops"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const m of list) {
    const row = el("tr");
    const basis = share ? m.unit === "ms" ? duration(m.denominator) : money(m.denominator) : number(m.denominator);
    row.append(el("td", "", m.label), el("td", "", render(m)), el("td", "", m.rate == null ? "—" : `${percent(m.rate)} of ${basis}`), el("td", "", String(m.operations)));
    body.append(row);
  }
  table.append(body);
  return tableContainer(table, share ? "Shares of recorded evidence" : "Recorded events and denominators");
}
function cohortRows(cohorts) {
  const table = el("table", "intel-metric-table");
  const head = el("tr");
  for (const col of ["Configuration", "Ops", "Delivered", "Known spend", "$/delivered", "Wait recorded"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const c of cohorts) {
    const row = el("tr");
    const per = c.delivered > 0 && c.knownCostUsd != null ? money(c.knownCostUsd / c.delivered) : "Unknown";
    row.append(el("td", "", c.key), el("td", "", String(c.operations)), el("td", "", String(c.delivered)), el("td", "", c.knownCostUsd == null ? "Unknown" : money(c.knownCostUsd) + (c.usagePartial ? "*" : "")), el("td", "", per), el("td", "", c.waitMs > 0 ? duration(c.waitMs) : "—"));
    body.append(row);
  }
  table.append(body);
  return tableContainer(table, "Configuration cohorts");
}
function rankedSection(title, list, render, share = false) {
  const section = el("section", "intel-ranking");
  section.append(el("h3", "intel-section-title", title));
  if (!list.length) {
    section.append(el("p", "intel-muted", "Nothing recorded yet. Fills in as evaluated operations record these classes; missing data is not a measured zero."));
    return section;
  }
  section.append(metricRows(list.slice(0, 3), render, share));
  if (list.length > 3) {
    const more = el("details", "intel-more");
    more.append(el("summary", "", `Show ${list.length - 3} more ${list.length === 4 ? "class" : "classes"}`));
    more.addEventListener("toggle", () => {
      if (more.open && more.children.length === 1) more.append(metricRows(list.slice(3), render, share));
    });
    section.append(more);
  }
  return section;
}
function rollupSection(rollup, open, opId) {
  const section = el("section", "intel-rollup");
  const t = rollup.totals;
  section.append(el("h2", "intel-section-title", "Fleet overview"));
  section.append(el("p", "intel-muted", `${rollup.sources.evaluated} evaluated sources · ${rollup.sources.open} open · ${rollup.sources.archived} archived · ${rollup.sources.missingEvaluation} without evaluation`));
  if (!rollup.sources.evaluated && !t.panes) {
    section.append(el("p", "intel-empty intel-muted", "No evaluated operations or pane spend recorded yet. Fills in once an operation launches missions or board panes report usage; missing history is not reconstructed."));
    return section;
  }
  if (rollup.sources.evaluated) {
    const heads = el("section", "intel-headlines");
    heads.setAttribute("aria-label", "Fleet totals");
    heads.append(
      headline("Delivered work", number(t.delivered), `${t.timed} timed contacts`),
      headline("Operation spend", money(t.knownCostUsd), t.knownCostUsd == null ? "No usage cost recorded" : t.usagePartial ? "Partial estimate · includes decision panes" : "Observed estimate · includes decision panes"),
      headline("Per delivered", money(t.costPerDelivered), "Includes unfinished operation work; excludes drafts"),
      headline("Review rounds", number(t.reviews), t.repairRounds == null ? "No quality instrumentation recorded" : `${number(t.repairRounds)} accepted repairs · not external acceptance`),
    );
    section.append(heads, docketSection(fleetDocket(rollup, { duration, money, number }), open, opId));
  }
  if (t.panes) {
    const paneNote = `${number(t.panes.sessions)} draft/decision sessions · ${number(t.panes.tokens)} tokens${t.panes.partial ? " · partial coverage" : ""}`;
    section.append(facts(rollup.sources.evaluated ? [
      ["Board panes · subtotal", money(t.panes.costUsd), paneNote],
      ["Draft spend", money(t.drafts?.costUsd), t.drafts ? "Board-wide; excluded from operation spend and cost per delivery." : "No closed-draft usage recorded."],
    ] : [["Draft spend", money(t.drafts?.costUsd), `${paneNote} · No operation evidence recorded yet.`]]));
  }
  if (rollup.sources.evaluated) {
    const rankings = el("details", "intel-subsection");
    rankings.append(el("summary", "", "Ranked failure, wait, cost and phase classes"));
    rankings.addEventListener("toggle", () => {
      if (rankings.open && rankings.children.length === 1) {
        const grid = el("div", "intel-rankings");
        grid.append(
          rankedSection("Recorded failures & rework", rollup.failures, m => number(m.value)),
          rankedSection("Where recorded time waits", rollup.waits, m => duration(m.value), true),
          rankedSection("Attributed phase costs", rollup.costs, m => money(m.value), true),
          rankedSection("Recorded phase durations", rollup.phases, m => duration(m.value), true),
        );
        rankings.append(grid);
      }
    });
    section.append(rankings);
  }
  if (rollup.cohorts.length > 1) {
    const box = el("details", "intel-subsection");
    box.append(el("summary", "", "Configuration cohorts · descriptive, not controlled comparisons"), cohortRows(rollup.cohorts));
    section.append(box);
  }
  const diagnostics = el("details", "intel-subsection");
  diagnostics.append(el("summary", "", "Coverage, tokens & limitations"), facts([
    ["Mission input / output", t.tokens ? `${number(t.tokens.input)} / ${number(t.tokens.output)}` : "Unknown"],
    ["Mission cache read / write", t.tokens ? `${number(t.tokens.cacheRead)} / ${number(t.tokens.cacheWrite)}` : "Unknown"],
  ]), el("p", "intel-muted", rollup.caveats.join(" ")));
  section.append(diagnostics);
  return section;
}
function evidenceDetails(e) {
  const q = e.quality, u = e.usage;
  const box = el("details", "intel-subsection");
  box.append(el("summary", "", "Recorded evidence & coverage"));
  box.addEventListener("toggle", () => {
    if (box.open && box.children.length === 1) {
      box.append(facts([
        ["Queue → launch", sample(e.queue), "Median finished queue wait."],
        ["Queue → delivery", sample(e.lead), "End-to-end lead for delivered work."],
        ["Still queued", e.queued.n ? `${e.queued.n} · oldest ${duration(e.queued.maxMs)}` : "None"],
        ["Launched, not delivered", e.unfinished.n ? `${e.unfinished.n} · oldest ${duration(e.unfinished.maxMs)}` : "None"],
        ["Dependency wait", duration(e.dependencyWaitMs)], ["Gate wait", duration(e.gateWaitMs)],
        ["Offline / unreachable", duration(e.offlineMs)], ["Ready → landed", duration(e.deliveryReadyMs)],
        ["Launches / relaunches", `${e.attempts.launches} / ${e.attempts.relaunches}`],
        ["Recorded passes / fails", q ? `${number(q.recordedPassed)} / ${number(q.recordedFailed)}` : "No quality instrumentation"],
        ["Review rounds / failures", q ? `${number(q.completedRounds)} / ${number(q.reviewFailures)}` : "—"],
        ["Accepted repairs", q ? number(q.acceptedRepairs) : "—"],
        ["Latest actionable findings", q ? number(q.latestActionable) : "—"],
        ["Known spend / delivered", `${money(u.knownCostUsd)} / ${money(u.costPerDelivered)}`],
        ["Usage coverage", `${e.coverage.usageReported} / ${e.coverage.launched} launched · basis ${u.basis}`],
        ["Missing / unsupported", `${number(u.missingSources)} / ${number(u.unsupportedWorkers)}`],
        ["Reset observations", number(u.resets + e.coverage.counterResets)],
        ["Connectivity mean / peak", e.connectivity.mean == null ? "Unknown" : `${decimal(e.connectivity.mean)} / ${e.connectivity.peak} missions`],
        ["Configuration", e.config.value ? `${e.config.value.graph} / ${e.config.value.frontend} / ${e.config.value.maxWorkers} workers / ${e.config.value.mode}` : "Uninstrumented"],
      ]));
    }
  });
  return box;
}
function experiments() {
  const box = el("details", "intel-experiments");
  box.append(el("summary", "", "Controlled comparisons · optional"));
  box.append(el("p", "intel-muted", "Compare archived maxWorkers configurations with the offline command below. Declare paired workloads, the same repository/base, acceptance criteria and environment; choose the baseline explicitly. Include incomplete and failed runs. At least five complete comparable pairs are required; missing coverage or contradictory observed configurations prevent stronger comparisons. External outcomes remain operator-assessed."));
  box.append(el("pre", "", "holotable compare --manifest /path/to/comparison.json"));
  box.append(el("p", "intel-muted", "Each manifest declares v: 1, variable: maxWorkers, baseline: A or B, groups: {A: workerLimit, B: workerLimit}, and trials with archive, group, pair, repo, baseCommit, workload, acceptance, environment, externalOutcome (pass / fail / unassessed). Results are descriptive, not causal; Intel never schedules experiments or changes configuration."));
  return box;
}
// throughputPerHour extrapolates from operation lifetime; under an hour that reads as an inflated rate,
// so short operations show the elapsed window instead.
function throughputNote(e) {
  if (e.throughputPerHour == null) return "No operation time recorded";
  if (!e.deliveredWork) return "None delivered yet";
  const elapsedMs = e.deliveredWork * 3_600_000 / e.throughputPerHour;
  if (elapsedMs < 3_600_000) return `In ${duration(elapsedMs)} since the operation was created`;
  return `${decimal(e.throughputPerHour)}/h over ${duration(elapsedMs)} since creation`;
}
function renderSnapshot(root, snapshot, open, opId) {
  root.replaceChildren();
  const title = el("div", "intel-title");
  title.append(el("h2", "", snapshot.name), el("span", "intel-badge", snapshot.closedAt ? "Frozen archive" : "Open operation · snapshot"));
  root.append(title);
  const e = snapshot.evaluation;
  if (!e) {
    root.append(el("p", "intel-empty intel-muted", "No evaluation stored for this archive (closed before Intel recorded evidence). Stored reports are not recalculated; operations closed now keep their close-time evaluation."), experiments());
    return;
  }
  const headlines = el("section", "intel-headlines");
  headlines.setAttribute("aria-label", "At a glance");
  headlines.append(
    headline("Delivered work", number(e.deliveredWork), throughputNote(e)),
    headline("Median launch → land", duration(e.delivery.medianMs), `${e.delivery.n} delivered measurements`),
    headline("Recorded check failures", number(e.quality?.recordedFailed), e.quality ? "Producer-reported, not external judgment" : "No quality instrumentation recorded"),
    headline("Known spend", money(e.usage.knownCostUsd), e.usage.knownCostUsd == null ? "No usage cost recorded" : e.usage.partial ? "Partial coverage" : e.usage.coordinatorSessionAssociated ? "Session-associated estimate" : "Observed estimate"),
  );
  root.append(headlines, docketSection(operationDocket(e, { duration, money, number, opId }), open, opId));
  const ledger = phaseLedger(e);
  if (ledger) root.append(ledger);
  root.append(evidenceDetails(e), experiments());
}
function reviewHelp() {
  const box = el("details", "intel-experiments");
  box.id = "intelReviewHelp";
  const code = el("code", "", "omp --model YOUR_SMALL_MODEL --no-tools --no-extensions --no-skills --no-rules --no-title --no-session --max-time 2m -p @holotable-intel-review.txt");
  const pre = el("pre");
  pre.append(code);
  box.append(
    el("summary", "", "Optional small-model review · manual"),
    el("p", "intel-muted", "Export the current scope, inspect the downloaded evidence, then choose a small model explicitly. Exporting and refreshing never call a model. The prompt contains aggregate measurements, coverage limits and evidence references—not transcripts or access tokens."),
    el("p", "intel-muted", "From the download directory, replace YOUR_SMALL_MODEL with your model selector:"),
    pre,
    el("p", "intel-muted", "This produces advisory interpretation, not an independent code check or permission to change missions. Two minutes is a wall-time limit, not a price cap. Model charges belong to the separate OMP session; they are not automatically added to this operation’s spend."),
  );
  return box;
}

/**
 * The Intel view's body inside `root`. The board owns what it shows (header picker → source, sub-tabs → scope)
 * and calls show(); evidence loads only when that pair changes, on Refresh, or after invalidate().
 * `sources(archives)` hands the archive list to the picker; `sourceGone()` asks the board to drop a vanished archive;
 * `openBoard({ plan, op, ticket })` follows a finding's link.
 */
export function createIntel(root, { api, sources, sourceGone, openBoard }) {
  const intro = el("div", "intel-intro");
  intro.append(
    el("p", "intel-eyebrow", "OPERATION INTELLIGENCE"),
    el("h1", "", "What’s helping. What’s holding work up."),
    el("p", "intel-muted", "Delivery, rework and resource use from recorded evidence. Read-only: no scores, no automatic changes, no model calls."),
  );
  const refresh = el("button", "btn", "Refresh snapshot");
  refresh.type = "button";
  const exportReview = el("button", "btn", "Export review prompt");
  exportReview.type = "button";
  exportReview.disabled = true;
  exportReview.title = "Downloads a bounded evidence prompt only; never launches a model";
  exportReview.setAttribute("aria-details", "intelReviewHelp");
  const snapshotTime = el("p", "intel-muted", "Loads only when opened or refreshed. No background updates.");
  snapshotTime.setAttribute("role", "status");
  const toolbar = el("section", "intel-toolbar");
  toolbar.setAttribute("aria-label", "Snapshot");
  toolbar.append(refresh, exportReview, snapshotTime);
  const status = el("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const rollupBox = el("section");
  rollupBox.setAttribute("aria-label", "Fleet overview");
  const dashboard = el("div");
  root.replaceChildren(intro, toolbar, status, rollupBox, dashboard, reviewHelp(), el("footer", "intel-footer", "Self-checks, reviews and landing are evidence of process—not externally verified correctness. Known cost is an estimate, not a bill."));

  let scope = null;
  let source = "";
  let sourcesLoaded = false;
  let notice = ""; // shown by the next load: it explains why the source changed
  let request = null;
  let generation = 0;
  let reviewEvidence = null;
  const get = async (path, signal) => fetchJson(await api(path, { signal }));
  const open = text => {
    const [kind, op, ticket] = text.split(":");
    openBoard({ plan: kind === "map", op, ticket });
  };
  function message(text, error = false) {
    status.replaceChildren(el("p", error ? "intel-error" : "intel-muted", text));
  }

  async function load() {
    request?.abort();
    reviewEvidence = null;
    exportReview.disabled = true;
    request = new AbortController();
    const signal = request.signal, current = ++generation;
    const fleet = scope === "fleet";
    rollupBox.hidden = !fleet;
    dashboard.hidden = fleet;
    const box = fleet ? rollupBox : dashboard;
    box.replaceChildren();
    box.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    snapshotTime.textContent = "Loading evidence…";
    message("Reading stored evidence…");
    let note = notice;
    notice = "";
    try {
      if (!sourcesLoaded) {
        try {
          const list = await get("/api/intel/sources", signal);
          if (current !== generation) return;
          sourcesLoaded = true;
          sources(list.archives);
          if (source.startsWith("archive:") && !list.archives.some(a => `archive:${a.key}` === source)) {
            notice = "The previous source is no longer available.";
            sourceGone(); // the board shows its selected operation instead, which starts the next load
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          note = `Source list unavailable: ${errorText(error)}. Refresh to retry.`;
        }
      }
      if (fleet) {
        const rollup = await get("/api/intel/rollup", signal);
        if (current !== generation) return;
        box.replaceChildren(rollupSection(rollup, open, opIdOf(source)));
        reviewEvidence = { scope: "fleet", rollup };
        snapshotTime.textContent = `Fleet evidence as of ${date(rollup.generatedAt)}. Refresh is manual.`;
      } else if (source) {
        const snapshot = await get(`/api/intel?${queryFor(source)}`, signal);
        if (current !== generation) return;
        renderSnapshot(dashboard, snapshot, open, opIdOf(source));
        reviewEvidence = snapshot.evaluation ? { scope: "operation", source, snapshot } : null;
        snapshotTime.textContent = `${snapshot.closedAt ? "Frozen at close" : "Evidence as of"} ${date(snapshot.evaluation?.asOf ?? snapshot.closedAt ?? Date.now())}. No background updates.`;
      } else {
        note = "No operations yet. Create one on the board; its evidence appears here once missions launch. Fleet overview can still show recorded draft spend.";
        snapshotTime.textContent = "No operation selected.";
      }
      message(note);
    } catch (error) {
      if (!signal.aborted && current === generation) {
        message(errorText(error), true);
        snapshotTime.textContent = `${fleet ? "Fleet overview" : "Operation snapshot"} unavailable. Refresh to retry or switch scope.`;
      }
    } finally {
      if (current === generation) {
        refresh.disabled = false;
        exportReview.disabled = !reviewEvidence;
        box.setAttribute("aria-busy", "false");
      }
    }
  }

  refresh.addEventListener("click", () => {
    sourcesLoaded = false;
    void load();
  });
  exportReview.addEventListener("click", () => {
    if (!reviewEvidence) return;
    try {
      const prompt = buildReviewPrompt(reviewEvidence);
      const url = URL.createObjectURL(new Blob([prompt], { type: "text/plain;charset=utf-8" }));
      const link = el("a");
      link.href = url;
      link.download = "holotable-intel-review.txt";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      message("Review prompt downloaded. No model was run. Choose a model explicitly using the optional review instructions below.");
    } catch (error) {
      message(errorText(error), true);
    }
  });

  return {
    /** Scope "op" | "fleet"; source "op:<id>", "archive:<key>" or "" (no operations). */
    show(nextScope, nextSource) {
      if (nextScope === scope && nextSource === source) return;
      scope = nextScope;
      source = nextSource;
      void load();
    },
    /** The next show() loads afresh, archive list included. */
    invalidate() {
      scope = null;
      sourcesLoaded = false;
    },
  };
}
