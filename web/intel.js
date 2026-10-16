import { el, errorText, fetchJson, fmtMs } from "./ui.js";

const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
const token = fragment || sessionStorage.getItem("holotable-token:/intel") || sessionStorage.getItem("holotable-token:/") || "";
if (token) sessionStorage.setItem("holotable-token:/intel", token);
if (fragment) history.replaceState(null, "", `${location.pathname}${location.search}`);
$("back").href = `/#${token}`;
const params = new URLSearchParams(location.search);
let selected = params.has("archive") ? `archive:${params.get("archive")}` : params.has("op") ? `op:${params.get("op")}` : "";
let request = null;
let generation = 0;
let activeTab = "performance";
const evidenceRequests = new Set();
const duration = n => n == null ? "Unknown" : n === 0 ? "0s" : fmtMs(n);
const money = n => n == null ? "Unknown" : `$${n.toFixed(2)}`;
const number = n => n == null ? "Unknown" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const sample = d => `${duration(d.medianMs)} · ${d.n} measured`;
const date = value => new Date(value).toLocaleString();
const queryFor = value => {
  const colon = value.indexOf(":");
  return new URLSearchParams([[value.slice(0, colon), value.slice(colon + 1)]]).toString();
};
async function api(path, signal) {
  return fetchJson(await fetch(path, { signal, headers: { "X-Holotable-Token": token }, credentials: "same-origin", cache: "no-store" }));
}
function message(text, error = false) {
  $("message").replaceChildren(el("p", error ? "intel-error" : "intel-muted", text));
}
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
function subsection(title, rows) {
  const box = el("details", "intel-subsection");
  box.append(el("summary", "", title));
  box.addEventListener("toggle", () => {
    if (box.open && box.children.length === 1) box.append(facts(rows));
  });
  return box;
}
function headline(label, value, note) {
  const card = el("dl", "intel-headline");
  card.append(el("dt", "", label), el("dd", "", value), el("p", "", note));
  return card;
}
function abortEvidence() {
  for (const controller of evidenceRequests) controller.abort();
  evidenceRequests.clear();
}
async function loadEvidence(root, button, rule, source) {
  const controller = new AbortController();
  evidenceRequests.add(controller);
  button.disabled = true;
  button.textContent = "Loading history…";
  try {
    const colon = source.indexOf(":");
    const archive = source.startsWith("archive:");
    const value = encodeURIComponent(source.slice(colon + 1));
    const response = await api(archive ? `/api/archive/report?key=${value}` : `/api/history?op=${value}`, controller.signal);
    const entries = archive ? response.history : response;
    const relevant = entries.filter(h => rule.evidence.contacts.includes(h.contact)).slice(0, 30);
    const list = el("ol", "intel-timeline");
    for (const entry of relevant) {
      const row = el("li");
      row.append(el("time", "", date(entry.at)), el("span", "", entry.text));
      list.append(row);
    }
    root.append(el("p", "intel-muted", "Latest 30 recorded actions for the referenced contacts. Numerical samples remain in the stored event history; the source event numbers above identify those records."));
    root.append(relevant.length ? list : el("p", "intel-muted", "No human-readable actions for these contacts. Refer to the numbered samples in the stored event history."));
    button.remove();
  } catch (error) {
    if (controller.signal.aborted) return;
    button.textContent = "Retry contact history";
    root.append(el("p", "intel-error", errorText(error)));
  } finally {
    evidenceRequests.delete(controller);
    button.disabled = false;
  }
}
function recommendations(e, source) {
  const section = el("section", "intel-recommendations");
  section.append(el("h2", "intel-section-title", "What to inspect next"));
  if (!e.recommendations.length) {
    section.append(el("p", "intel-muted", "No recommendation thresholds reached in the recorded evidence. That is not a clean bill of health; small samples and missing evidence limit conclusions."));
  }
  for (const rule of e.recommendations.slice(0, 3)) {
    const card = el("article", `intel-rule ${rule.level}`);
    card.append(el("h3", "", rule.message));
    const r = rule.evidence;
    card.append(el("p", "intel-muted", `${r.numerator}${r.denominator == null ? " recorded" : ` / ${r.denominator} observed`}${r.observedMs == null ? "" : ` · ${duration(r.observedMs)}`}`));
    const detail = el("details");
    detail.append(el("summary", "", "Why this appears & evidence"), el("p", "intel-muted", rule.caveat));
    detail.append(el("p", "intel-muted", `${r.contacts.join(", ") || "Operation-wide"}${r.eventIndexes.length ? ` · source events ${r.eventIndexes.map(i => i + 1).join(", ")}` : ""} · rule v${rule.ruleVersion}`));
    if (r.contacts.length) {
      const button = el("button", "btn small", "View contact history");
      button.type = "button";
      button.addEventListener("click", () => loadEvidence(detail, button, rule, source));
      detail.append(button);
    }
    card.append(detail);
    section.append(card);
  }
  return section;
}
const tabs = [
  ["performance", "Delivery & speed"], ["quality", "Quality & rework"],
  ["efficiency", "Tokens & cost"], ["waits", "Bottlenecks"], ["fleet", "Fleet effectiveness"],
];
function metricRows(list, render) {
  const table = el("table", "intel-metric-table");
  const head = el("tr");
  for (const col of ["Class", "Recorded", "Rate", "Operations"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const m of list) {
    const row = el("tr");
    row.append(el("td", "", m.label), el("td", "", render(m)), el("td", "", m.rate == null ? "—" : `${Math.round(m.rate * 100)}%`), el("td", "", String(m.operations)));
    body.append(row);
  }
  table.append(body);
  return table;
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
  return table;
}
function rollupSection(rollup) {
  const section = el("section", "intel-rollup");
  section.append(el("h2", "intel-section-title", "Fleet rollup"));
  section.append(el("p", "intel-muted", `${rollup.sources.evaluated} evaluated source${rollup.sources.evaluated === 1 ? "" : "s"} (${rollup.sources.open} open, ${rollup.sources.archived} archived) · generated on demand, no model calls.`));
  if (!rollup.sources.evaluated) { section.append(el("p", "intel-muted", "No evaluations recorded yet. Close an operation or collect producer evidence; this section stays hidden until data exists.")); }
  else {
    const t = rollup.totals;
    const heads = el("section", "intel-headlines");
    heads.setAttribute("aria-label", "Fleet totals");
    heads.append(
      headline("Delivered work", number(t.delivered), `${t.timed} timed contacts recorded`),
      headline("Known spend", money(t.knownCostUsd), t.usagePartial ? "Partial or session-associated coverage" : "Observed estimate"),
      headline("Per delivered", money(t.costPerDelivered), `${number(t.reviews)} review rounds · ${number(t.repairRounds)} repairs`),
      headline("Cache read", t.tokens ? number(t.tokens.cacheRead) : "Unknown", t.tokens ? `${number(t.tokens.input)} input · ${number(t.tokens.output)} output` : "No usage tokens recorded"),
    );
    section.append(heads);
    if (rollup.failures.length) {
      const box = el("details", "intel-subsection");
      box.append(el("summary", "", "Biggest recorded failure classes"), metricRows(rollup.failures, m => m.value.toLocaleString()));
      section.append(box);
    }
    if (rollup.waits.length) {
      const box = el("details", "intel-subsection");
      box.append(el("summary", "", "Where recorded time waits"), metricRows(rollup.waits, m => duration(m.value)));
      section.append(box);
    }
    if (rollup.costs.length) {
      const box = el("details", "intel-subsection");
      box.append(el("summary", "", "Phase costs (attributed usage)"), metricRows(rollup.costs, m => `$${m.value.toFixed(2)}`));
      section.append(box);
    }
    if (rollup.phases.length) {
      const box = el("details", "intel-subsection");
      box.append(el("summary", "", "Phase totals across operations"), metricRows(rollup.phases, m => duration(m.value)));
      section.append(box);
    }
    if (rollup.cohorts.length > 1) {
      const box = el("details", "intel-subsection");
      box.append(el("summary", "", "Configuration cohorts"), cohortRows(rollup.cohorts));
      section.append(box);
    }
  }
  if (rollup.caveats.length) section.append(el("p", "intel-muted", rollup.caveats.join(" ")));
  return section;
}
function renderPanel(root, id, e) {
  root.replaceChildren();
  const u = e.usage, q = e.quality;
  const intro = (title, description) => root.append(el("h2", "intel-section-title", title), el("p", "intel-muted", description));
  if (id === "performance") {
    intro("Is work reaching delivery faster?", "Finished waits and deliveries are measured separately from unfinished work. Compare like workloads, not just headline totals.");
    root.append(facts([
      ["Queue → launch", sample(e.queue), "Median finished queue wait, including intentional parking."],
      ["Queue → delivery", sample(e.lead), "End-to-end lead time for delivered work."],
      ["Still queued", `${e.queued.n} · oldest ${duration(e.queued.maxMs)}`],
      ["Launched, not delivered", `${e.unfinished.n} · oldest ${duration(e.unfinished.maxMs)}`, "Includes incomplete missions, not just active execution."],
    ]));
    root.append(subsection("Phase durations & timing coverage", [
      ...Object.entries(e.phaseMs).map(([phase, ms]) => [`Time in ${phase}`, duration(ms)]),
      ["Timed contacts", number(e.coverage.timed)], ["Launched contacts", number(e.coverage.launched)],
      ["Delivery p90", e.delivery.n >= 10 ? duration(e.delivery.p90Ms) : "Not enough samples", "Requires at least 10 measurements."],
      ["Queue p90", e.queue.n >= 10 ? duration(e.queue.p90Ms) : "Not enough samples", "Requires at least 10 measurements."],
      ["Clock anomalies", number(e.coverage.clockAnomalies)],
    ]));
  } else if (id === "quality") {
    intro("Where is work being repeated?", "Verification and reviews are producer-reported quality proxies, not external acceptance. Finding occurrences across rounds are not unique defects.");
    if (!q) { root.append(el("p", "intel-muted", "Quality evidence not recorded. Older missions remain unknown; run new instrumented missions to collect verification, review and repair counters.")); return; }
    root.append(facts([
      ["Recorded passes", number(q.recordedPassed), "Failed checks are shown in the headline above."],
      ["Repeated failed revision", number(q.repeatedFailedRevision), "A shared fingerprint is not proof of the same root cause."],
      ["Review rounds", number(q.completedRounds)], ["Review failures", number(q.reviewFailures)],
      ["Accepted repairs", number(q.acceptedRepairs)], ["Finding occurrences", number(q.findingOccurrences)],
    ]));
    root.append(subsection("Findings, invalidations & instrumentation", [
      ["Latest actionable findings", number(q.latestActionable)], ["Latest rejected findings", number(q.latestRejected)],
      ...Object.entries(q.severity).map(([severity, n]) => [`Latest ${severity} findings`, number(n)]),
      ["Invalidated review rounds", number(q.invalidatedRounds)], ["Merge preflight failures", number(q.mergePreflightFailures)],
      ["Boundary failures", number(q.boundaryFailures)], ["Evidence since", date(q.since)],
    ]));
  } else if (id === "efficiency") {
    intro("Where are tokens and known spend going?", "Associated observed spend includes unfinished work and may include other coordinator-session work. These estimates are not subscription billing or exact mission-exclusive cost.");
    root.append(facts([
      ["Known estimate / delivery", money(u.costPerDelivered), "Includes associated spend on unfinished work."],
      ["Usage reported", `${e.coverage.usageReported} / ${e.coverage.launched} launched contacts`, `Accounting basis: ${u.basis}`],
      ["Input tokens", number(u.tokens?.input)], ["Output tokens", number(u.tokens?.output)],
      ["Cache read / write", u.tokens ? `${number(u.tokens.cacheRead)} / ${number(u.tokens.cacheWrite)}` : "Unknown", "Provider categories, not a universal cache hit rate."],
    ]));
    if (u.byPhase && Object.keys(u.byPhase).length) {
      root.append(subsection("Usage by phase (sample-time attribution)", Object.entries(u.byPhase).map(([phase, v]) => [
        phase, `${number(v.tokens)} tokens${v.costUsd !== null ? ` · $${v.costUsd.toFixed(2)}` : ""}`,
        "Delta attributed to the phase active when the usage sample arrived; boundaries are approximate.",
      ])));
    }
    root.append(subsection("Accounting coverage & diagnostics", [
      ["Missing sources", number(u.missingSources)], ["Unsupported workers", number(u.unsupportedWorkers)],
      ["Priced messages", number(u.pricedMessages)], ["Unpriced messages", number(u.unpricedMessages)],
      ["Unread usage backlog", `${number(u.backlogBytes)} bytes`], ["Malformed lines", number(u.malformedLines)],
      ["Reset observations", number(u.resets + e.coverage.counterResets)], ["Legacy contacts", number(e.coverage.legacyUsage)],
    ]));
  } else if (id === "waits") {
    intro("What is holding delivery up?", "Observed elapsed intervals can overlap. Unreachable does not mean idle, and waiting is not necessarily waste.");
    root.append(facts([
      ["Approval gates", duration(e.gateWaitMs)], ["Dependency blocking", duration(e.dependencyWaitMs)],
      ["Offline / unreachable", duration(e.offlineMs)], ["Complete → landed", duration(e.deliveryReadyMs), "Total observed delay for delivered work after completion."],
      ["Review phase", duration(e.phaseMs.review)], ["Delivery conflicts", `${e.attempts.conflicts} / ${e.attempts.landAttempts} attempts`, "Recorded integration friction, not a causal concurrency score."],
    ]));
    root.append(subsection("Observed hold reasons", Object.entries(e.holdMs).map(([hold, ms]) => [hold, duration(ms)])));
  } else {
    intro("Is more concurrency helping?", "Connectivity and nonclosed-worker occupancy are sampled capacity proxies, not productive CPU time. One operation alone cannot establish whether greater concurrency helps.");
    root.append(facts([
      ["Connected coordinators", e.connectivity.mean == null ? "Unknown" : `${number(e.connectivity.mean)} average · ${e.connectivity.peak} peak`],
      ["Worker occupancy", e.workers.coveredMs ? `${number(e.workers.nonclosedWorkerMs / e.workers.coveredMs)} average` : "Unknown", "Nonclosed workers include reserved or missing workers."],
      ["Launches / relaunches", `${e.attempts.launches} / ${e.attempts.relaunches}`],
      ["Launch failures", number(e.attempts.launchFailures)], ["Dispatch reservations", number(e.fleet.workerAttempts), "A reservation need not have launched a session."],
      ["Repeated reservations", number(e.fleet.redispatches), "May reuse sessions; not necessarily wasted execution."],
    ]));
    const c = e.config.value;
    root.append(subsection("Configuration, retries & observation coverage", [
      ["Worker limit", c ? number(c.maxWorkers) : "Unknown"], ["Review concurrency", c ? number(c.reviewConcurrency) : "Unknown"],
      ["Graph / frontend", c ? `${c.graph} / ${c.frontend}` : "Unknown"], ["Mode", c?.mode ?? "Unknown"],
      ["Mixed configurations", e.config.mixed ? "Yes — not one experiment" : "No observed changes"],
      ["Worker beads", number(e.fleet.workerBeads)], ["Repair round", number(e.fleet.repairRound)],
      ["Repair links", number(e.fleet.repairLinks)], ["Board resend requests", number(e.fleet.boardResendRequests)],
      ["Worker-time observed", duration(e.workers.nonclosedWorkerMs)], ["Worker observation coverage", duration(e.workers.coveredMs)],
      ["Connectivity observation", duration(e.connectivity.observedMs)],
    ]));
  }
}
function experiments() {
  const box = el("details", "intel-experiments");
  box.append(el("summary", "", "Controlled comparisons · optional"));
  box.append(el("p", "intel-muted", "Compare archived maxWorkers configurations with the offline command below. Declare paired workloads, the same repository/base, acceptance criteria and environment; choose the baseline explicitly. Include incomplete and failed runs. At least five complete comparable pairs are required; missing coverage or contradictory observed configurations prevent stronger comparisons. External outcomes remain operator-assessed."));
  box.append(el("pre", "", "holotable compare --manifest /path/to/comparison.json"));
  box.append(el("p", "intel-muted", "Each manifest declares v: 1, variable: maxWorkers, baseline: A or B, groups: {A: workerLimit, B: workerLimit}, and trials with archive, group, pair, repo, baseCommit, workload, acceptance, environment, externalOutcome (pass / fail / unassessed). Results are descriptive, not causal; Intel never schedules experiments or changes configuration."));
  return box;
}
function renderSnapshot(snapshot, source) {
  const root = $("dashboard");
  root.replaceChildren();
  const title = el("div", "intel-title");
  title.append(el("h2", "", snapshot.name), el("span", "intel-badge", snapshot.closedAt ? "Frozen archive" : "Open operation · snapshot"));
  root.append(title);
  const e = snapshot.evaluation;
  if (!e) {
    root.append(el("p", "intel-empty intel-muted", "Evaluation not recorded for this archive. Stored reports are not silently recalculated; new operation reports preserve their close-time evaluation."), experiments());
    return;
  }
  const headlines = el("section", "intel-headlines");
  headlines.setAttribute("aria-label", "At a glance");
  headlines.append(
    headline("Delivered work", number(e.deliveredWork), `${number(e.throughputPerHour)} per operation hour`),
    headline("Median delivery", duration(e.delivery.medianMs), `${e.delivery.n} delivered measurements`),
    headline("Recorded check failures", number(e.quality?.recordedFailed), e.quality ? "Producer-reported, not external judgment" : "No quality instrumentation recorded"),
    headline("Known spend", money(e.usage.knownCostUsd), e.usage.partial ? "Partial coverage" : e.usage.coordinatorSessionAssociated ? "Session-associated estimate" : "Observed estimate"),
  );
  root.append(headlines, recommendations(e, source));
  const nav = el("div", "intel-tabs");
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Intel facets");
  const panel = el("section", "intel-panel");
  panel.id = "intel-facet";
  panel.tabIndex = 0;
  panel.setAttribute("role", "tabpanel");
  const choose = id => {
    activeTab = id;
    for (const button of nav.children) {
      const active = button.dataset.facet === id;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `tab-${id}`);
    renderPanel(panel, id, e);
  };
  for (const [id, label] of tabs) {
    const button = el("button", "intel-tab", label);
    button.type = "button";
    button.id = `tab-${id}`;
    button.dataset.facet = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panel.id);
    button.addEventListener("click", () => choose(id));
    button.addEventListener("keydown", event => {
      const index = tabs.findIndex(([key]) => key === activeTab);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      choose(tabs[next][0]);
      nav.children[next].focus();
    });
    nav.append(button);
  }
  choose(activeTab);
  root.append(nav, panel, experiments());
}
async function loadSnapshot(signal, current) {
  const source = selected;
  const snapshot = await api(`/api/intel?${queryFor(source)}`, signal);
  if (current !== generation) return;
  renderSnapshot(snapshot, source);
  $("snapshotTime").textContent = `${snapshot.closedAt ? "Frozen at close" : "Evidence as of"} ${date(snapshot.evaluation?.asOf ?? snapshot.closedAt ?? Date.now())}. No background updates.`;
  message("");
}
async function load(reloadSources = false) {
  request?.abort();
  abortEvidence();
  request = new AbortController();
  const signal = request.signal, current = ++generation;
  $("refresh").disabled = true;
  $("source").disabled = true;
  $("dashboard").replaceChildren();
  $("dashboard").setAttribute("aria-busy", "true");
  $("snapshotTime").textContent = "Loading snapshot…";
  message("Reading stored evidence…");
  try {
    if (!token) throw new Error("No access token. Open Intel from your authenticated Holotable page.");
    if (reloadSources) {
      const select = $("source");
      select.replaceChildren();
      const [sources, rollup] = await Promise.all([api("/api/intel/sources", signal), api("/api/intel/rollup", signal)]);
      $("rollup").replaceChildren(rollupSection(rollup));
      if (current !== generation) return;
      for (const [label, key, rows] of [["Open operations", "op", sources.operations], ["Archived operations", "archive", sources.archives]]) {
        const group = el("optgroup");
        group.label = label;
        for (const row of rows) {
          const option = el("option", "", `${row.name}${key === "archive" ? ` · ${new Date(row.closedAt).toLocaleDateString()}` : ""}`);
          option.value = `${key}:${key === "archive" ? row.key : row.id}`;
          group.append(option);
        }
        if (rows.length) select.append(group);
      }
      const values = [...select.options].map(option => option.value);
      if (selected && !values.includes(selected)) throw new Error("That operation is no longer available. Choose another operation or refresh the source list.");
      if (!selected) {
        const saved = sessionStorage.getItem("holotable.intel.selection") || `op:${localStorage.getItem("holotable.op")}`;
        selected = values.includes(saved) ? saved : values[0] || "";
      }
      if (!selected) { message("No operations yet. Run work in Holotable; evidence is kept automatically and archived at close."); $("snapshotTime").textContent = "No snapshot selected."; return; }
      select.value = selected;
    }
    history.replaceState(null, "", `/intel?${queryFor(selected)}`);
    sessionStorage.setItem("holotable.intel.selection", selected);
    await loadSnapshot(signal, current);
  } catch (error) {
    if (!signal.aborted) { message(errorText(error), true); $("snapshotTime").textContent = "Snapshot unavailable. Refresh to retry."; }
  } finally {
    if (current === generation) {
      $("refresh").disabled = false;
      $("source").disabled = !$("source").options.length;
      $("dashboard").setAttribute("aria-busy", "false");
    }
  }
}
$("source").addEventListener("change", () => { selected = $("source").value; void load(); });
$("refresh").addEventListener("click", () => { selected = $("source").value || selected; void load(true); });
window.addEventListener("pagehide", () => { request?.abort(); abortEvidence(); });
void load(true);
