// Live usage tooltip on the header's Load stat (GET /api/usage). While the stat is hovered,
// keyboard-focused or its click-opened chip is pinned it samples every ~2 s and renders
// this operation / all operations / the machine; nothing is fetched otherwise. The stat's
// `title` stays in data-tip as the dim footer line, so the static explanation never fights
// the live numbers.
import { el } from "./components.js";
import { icon } from "./icons.js";
import { setTipRenderer, refreshTooltip, tooltipOwner } from "./tooltip.js";

const REFRESH_MS = 2000;
const HOT = 80;
const CRIT = 95;

const gib = (bytes) => bytes / 1024 ** 3;
const fmtGb = (bytes) => {
  const g = gib(bytes);
  return `${g >= 10 || Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)} GB`;
};
const fmtPct = (pct) => (pct === null || pct === undefined ? "—" : `${Math.round(pct)}%`);
function metric(tip, label, hot) {
  tip.append(el("span", hot === "crit" ? "bad-text" : hot === "warn" ? "warn-text" : "", label));
}

const heat = (pct) => (pct === null || pct === undefined ? null : pct > CRIT ? "crit" : pct > HOT ? "warn" : null);
// Sessions come from the board (what it launched); processes from /proc under their worktrees,
// so a pane whose processes are not visible here (another host, a demo) still reads honestly.
function opLine(root, label, u, sessions) {
  const line = el("div", "tip-line");
  const procs = u.processes ? `${u.processes} process${u.processes === 1 ? "" : "es"}` : "no processes visible";
  line.append(el("b", "", label), document.createTextNode(` · ${sessions} omp (${procs}) · `));
  metric(line, `CPU ${fmtPct(u.cpuPct)}`, heat(u.cpuPct));
  line.append(document.createTextNode(" · "));
  metric(line, `MEM ${fmtGb(u.memBytes)}${u.memPct !== null ? ` (${fmtPct(u.memPct)})` : ""}`, heat(u.memPct));
  root.append(line);
}

function machineLine(root, m) {
  const line = el("div", "tip-line");
  line.append(el("b", "", "Machine"), document.createTextNode(" · "));
  const cores = m.cpus ? ` of ${m.cpus} cores` : "";
  metric(line, `CPU ${fmtPct(m.cpuPct)}${cores}`, heat(m.cpuPct));
  line.append(document.createTextNode(" · "));
  const mem =
    m.memUsedBytes !== null && m.memTotalBytes !== null
      ? `MEM ${fmtGb(m.memUsedBytes)} / ${fmtGb(m.memTotalBytes)} (${fmtPct(m.memPct)})`
      : "MEM —";
  metric(line, mem, heat(m.memPct));
  root.append(line);
}

/**
 * `stat` is the .stat block carrying #load; `api(path)`, `opId()`, `sessions()` ({op, all}
 * live omp counts from the projection) and `ops()` (open operation count) come from app.js
 * so the selected operation is read at fetch time, not bind time.
 */
export function installLoadTip(stat, { api, opId, sessions, ops }) {
  let data = undefined; // undefined = never fetched, null = error/no answer
  let hovering = false;
  let chipOpen = false;
  let timer = null;
  let inFlight = false;
  const chip = stat.querySelector("#loadChip");

  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  // One sample loop serves hover, the open tooltip and the pinned chip — never two polls.
  const active = () => hovering || chipOpen || tooltipOwner() === stat;

  const render = (tip) => {
    if (data === undefined) {
      tip.append(el("div", "tip-line dim", "Sampling CPU and memory…"));
    } else if (data === null) {
      tip.append(el("div", "tip-line dim", "Usage unavailable on this host"));
    } else {
      const s = sessions();
      // "All operations" only carries extra information past the first open operation;
      // with one it would repeat "This operation" line for line.
      if (data.op) opLine(tip, "This operation", data.op, s.op);
      if (!data.op || ops() > 1) opLine(tip, "All operations", data.all, s.all);
      machineLine(tip, data.machine);
    }
    tip.append(el("div", "tip-line dim", stat.dataset.tip ?? ""));
  };

  function fillChip() {
    if (!chip) return;
    chip.replaceChildren();
    const u = data ? data.op : null;
    if (!u) {
      chip.append(el("span", "dim", data === null ? "unavailable" : "—"));
      return;
    }
    chip.append(icon("cpu", { size: 11 }));
    metric(chip, fmtPct(u.cpuPct), heat(u.cpuPct));
    chip.append(el("span", "dim", "·"));
    chip.append(icon("memory-stick", { size: 11 }));
    metric(chip, fmtPct(u.memPct), heat(u.memPct));
  }

  function setChip(open) {
    chipOpen = open;
    stat.setAttribute("aria-expanded", String(open));
    stat.setAttribute("aria-pressed", String(open));
    if (chip) {
      chip.hidden = !open;
      if (open) fillChip();
    }
    if (open) tick();
    else if (!active()) stop();
  }

  async function poll() {
    if (inFlight) return;
    if (document.visibilityState !== "visible") return;
    if (!active()) return;
    inFlight = true;
    try {
      const id = opId();
      const res = await api(`/api/usage${id ? `?op=${encodeURIComponent(id)}` : ""}`);
      if (document.visibilityState !== "visible" || !active()) return;
      data = res.ok ? await res.json() : null;
    } catch {
      data = null;
    } finally {
      inFlight = false;
    }
    if (chipOpen) fillChip();
    if (tooltipOwner() === stat) refreshTooltip();
  }

  function tick() {
    stop();
    if (document.visibilityState !== "visible") return;
    if (!active()) return;
    void poll();
    if (document.visibilityState === "visible" && active()) {
      timer = setTimeout(tick, REFRESH_MS);
    }
  }

  // pointerenter fires before the tooltip's own arming pointerover, so the first sample is
  // usually ready when the 350 ms delay ends.
  stat.addEventListener("pointerenter", () => {
    if (document.visibilityState !== "visible") return;
    hovering = true;
    tick();
  });
  stat.addEventListener("pointerleave", () => {
    hovering = false;
    if (!active()) stop();
  });
  stat.addEventListener("focusin", (event) => {
    if (!event.target.matches(":focus-visible")) return;
    if (document.visibilityState !== "visible") return;
    tick();
  });
  stat.addEventListener("focusout", () => {
    if (!active()) stop();
  });
  stat.addEventListener("click", () => setChip(!chipOpen));
  stat.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // The board's global keydown maps a bare Enter to the card's primary action.
    event.preventDefault();
    event.stopPropagation();
    setChip(!chipOpen);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      stop();
    } else if (active()) {
      tick();
    }
  });
  setTipRenderer(stat, render, () => {
    if (!active()) stop();
  });
}
