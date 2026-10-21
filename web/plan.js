// Plan view: the whole operation as a dependency map by zone, and its full history.
// Answers "what is the plan, what is in the way, and where did each thing come from".
import { addContactButton } from "./addcontact.js";
import { clock, el, needsYou, statePill } from "./ui.js";

const ACTOR_WORD = { operator: "you", model: "model", mission: "mission", board: "board" };

export function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!(ms >= 0)) return "";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Depth in the blocker graph: a contact sits below everything it waits for. */
function depths(contacts) {
  const byTicket = new Map(contacts.map((c) => [c.ticket, c]));
  const memo = new Map();
  const depth = (c, seen = new Set()) => {
    if (memo.has(c.ticket)) return memo.get(c.ticket);
    if (seen.has(c.ticket)) return 0;
    seen.add(c.ticket);
    const parents = [...c.blockedBy.map((b) => b.ticket), ...(c.conflictOf ? [c.conflictOf] : [])]
      .map((t) => byTicket.get(t))
      .filter(Boolean);
    const d = parents.length ? 1 + Math.max(...parents.map((p) => depth(p, seen))) : 0;
    memo.set(c.ticket, d);
    return d;
  };
  for (const c of contacts) depth(c);
  return memo;
}

/** Tickets connected to `ticket` through blockers and conflicts, both directions. */
export function chainOf(projection, ticket) {
  const up = new Map();
  const down = new Map();
  const link = (from, to) => {
    if (!down.has(from)) down.set(from, []);
    if (!up.has(to)) up.set(to, []);
    down.get(from).push(to);
    up.get(to).push(from);
  };
  for (const c of projection.contacts) {
    for (const b of c.blockedBy) link(b.ticket, c.ticket);
    if (c.conflictOf) link(c.conflictOf, c.ticket);
  }
  const out = new Set([ticket]);
  for (const graph of [up, down]) {
    const stack = [ticket];
    while (stack.length) {
      const t = stack.pop();
      for (const n of graph.get(t) ?? []) if (!out.has(n)) out.add(n), stack.push(n);
    }
  }
  return out;
}

function node(c, selected, chain) {
  const dim = chain !== null && !chain.has(c.ticket);
  const box = el("button", `node s-${c.state}${c.ticket === selected ? " on" : ""}${dim ? " dim" : ""}${c.state === "landed" ? " done" : ""}`);
  box.type = "button";
  box.dataset.id = c.ticket;
  box.dataset.key = `node/${c.ticket}`;
  box.dataset.ticket = c.ticket;
  const taskText = c.title ?? c.ticket;
  const statusNote = c.detail ? ` (${c.detail})` : "";
  box.title = `${c.ticket}: ${taskText}${statusNote} · Click to trace, double-click to open`;
  box.setAttribute("aria-label", `${c.ticket}: ${taskText}`);
  const top = el("div", "node-top");
  top.append(statePill(c), el("span", "mono", c.ticket));
  box.append(top, el("div", "node-title", taskText));
  if (c.state !== "landed") {
    const unlanded = c.blockedBy?.filter((b) => !b.landed).map((b) => b.ticket) ?? [];
    if (unlanded.length > 0) {
      const cue = unlanded.length <= 2 ? `waits on ${unlanded.join(", ")}` : `waits on ${unlanded[0]} +${unlanded.length - 1}`;
      box.append(el("div", "node-cue", cue));
    } else if (c.kind === "closer" && c.state === "blocked") {
      box.append(el("div", "node-cue", "after everything else lands"));
    } else if (c.conflictOf) {
      box.append(el("div", "node-cue", `conflict of ${c.conflictOf}`));
    } else if (c.phase && c.state !== "conflict") {
      box.append(el("div", "node-cue", c.phase));
    }
  }
  return box;
}

/** Draws blocker and conflict arrows between nodes; called after layout and on resize. */
export function drawLinks(root, projection, focus) {
  const svg = root.querySelector("svg.links");
  const canvas = root.querySelector(".map-canvas");
  if (!svg || !canvas) return;
  const origin = canvas.getBoundingClientRect();
  svg.setAttribute("width", String(canvas.scrollWidth));
  svg.setAttribute("height", String(canvas.scrollHeight));
  svg.replaceChildren();
  const box = (t) => canvas.querySelector(`[data-ticket="${CSS.escape(t)}"]`)?.getBoundingClientRect();
  const chain = focus ? chainOf(projection, focus) : null;
  const ns = "http://www.w3.org/2000/svg";
  const marker = (id, color) => {
    const m = document.createElementNS(ns, "marker");
    for (const [k, v] of Object.entries({ id, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto" })) m.setAttribute(k, v);
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M0,0 L8,4 L0,8 z");
    p.setAttribute("fill", color);
    m.append(p);
    return m;
  };
  const defs = document.createElementNS(ns, "defs");
  defs.append(marker("arrow", "var(--line-2)"), marker("arrow-on", "var(--accent)"), marker("arrow-ok", "var(--ok)"), marker("arrow-bad", "var(--bad)"));
  svg.append(defs);
  const edge = (from, to, kind) => {
    const a = box(from);
    const b = box(to);
    if (!a || !b) return;
    const x = (r, side) => (side === "l" ? r.left : side === "r" ? r.right : r.left + r.width / 2) - origin.left + canvas.scrollLeft;
    const y = (r, side) => (side === "t" ? r.top : side === "b" ? r.bottom : r.top + r.height / 2) - origin.top + canvas.scrollTop;
    let d;
    if (Math.abs(a.left - b.left) < 20) {
      // Same column: leave from the bottom, enter at the top.
      const x1 = x(a, "c");
      const y1 = y(a, "b");
      const x2 = x(b, "c");
      const y2 = y(b, "t");
      d = `M${x1},${y1} C${x1},${y1 + 24} ${x2},${y2 - 24} ${x2},${y2 - 2}`;
    } else {
      const forward = a.left < b.left;
      const x1 = x(a, forward ? "r" : "l");
      const y1 = y(a, "m");
      const x2 = x(b, forward ? "l" : "r");
      const y2 = y(b, "m");
      const bend = Math.max(30, Math.abs(x2 - x1) / 2);
      d = `M${x1},${y1} C${x1 + (forward ? bend : -bend)},${y1} ${x2 - (forward ? bend : -bend)},${y2} ${x2 + (forward ? -2 : 2)},${y2}`;
    }
    const on = chain && chain.has(from) && chain.has(to);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    const cls = kind === "conflict" ? "bad" : kind === "landed" ? "ok" : "";
    path.setAttribute("class", `link ${cls}${on ? " on" : ""}${chain && !on ? " dim" : ""}`);
    path.setAttribute("marker-end", `url(#${on ? "arrow-on" : cls ? `arrow-${cls}` : "arrow"})`);
    svg.append(path);
  };
  for (const c of projection.contacts) {
    for (const b of c.blockedBy) edge(b.ticket, c.ticket, b.landed ? "landed" : "wait");
    if (c.conflictOf) edge(c.conflictOf, c.ticket, "conflict");
  }
}

export function renderMap(root, projection, selected, focus, onAdd = null) {
  root.replaceChildren();
  const contacts = projection.contacts;
  const count = (pred) => contacts.filter(pred).length;
  const summary = el("div", "map-summary");
  summary.append(
    el("b", "", projection.operation.name),
    el("span", "", `${contacts.length} contacts`),
    el("span", "", `${count((c) => c.state === "landed")} landed`),
    el("span", "", `${count((c) => c.group === "live" && c.state !== "landed")} live`),
    el("span", "", `${count((c) => c.group === "queue")} queued`),
  );
  const needs = count((c) => c.attention);
  if (needs) summary.append(el("span", "warn", needsYou(needs)));
  if (projection.notes?.total) summary.append(el("span", "", `${projection.notes.done}/${projection.notes.total} tasks done`));
  summary.append(el("span", "map-legend", "arrows: waits for → · green: landed · red dashed: conflict"));
  if (onAdd) summary.append(addContactButton(onAdd));
  root.append(summary);

  const canvas = el("div", "map-canvas");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "links");
  svg.setAttribute("aria-hidden", "true");
  canvas.append(svg);
  const cols = el("div", "map-cols");
  const depth = depths(contacts);
  const chain = focus ? chainOf(projection, focus) : null;
  const zones = [...projection.operation.zones];
  const known = new Set(zones.map((z) => z.id));
  if (contacts.some((c) => c.kind !== "closer" && !known.has(c.zone))) zones.push({ id: "", label: "No zone" });
  // The closer waits for everything without an arrow from each contact: it gets its own column, last.
  const closer = contacts.find((c) => c.kind === "closer");
  for (const zone of zones) {
    const members = contacts.filter((c) => c.kind !== "closer" && (zone.id ? c.zone === zone.id : !known.has(c.zone)));
    // A zone made only to hold the closer would be an empty column beside the closer's own.
    if (!members.length && closer?.zone === zone.id) continue;
    // Tree order inside a column: each contact is followed by what waits on it, so arrows stay short.
    const ordered = [];
    const placed = new Set();
    const children = (t) => members.filter((m) => !placed.has(m.ticket) && (m.conflictOf === t || m.blockedBy.some((b) => b.ticket === t)));
    const visit = (c) => {
      placed.add(c.ticket);
      ordered.push(c);
      for (const child of children(c.ticket)) if (!placed.has(child.ticket)) visit(child);
    };
    for (const c of [...members].sort((a, b) => depth.get(a.ticket) - depth.get(b.ticket))) if (!placed.has(c.ticket)) visit(c);
    members.splice(0, members.length, ...ordered);
    const col = el("section", "map-col");
    const head = el("div", "map-col-head");
    const landed = members.filter((c) => c.state === "landed").length;
    head.append(el("span", "", zone.label), el("span", "count", `${landed}/${members.length}`));
    const meter = el("div", "meter");
    const fill = el("span", "");
    fill.style.width = members.length ? `${Math.round((landed / members.length) * 100)}%` : "0";
    meter.append(fill);
    col.append(head, meter);
    if (!members.length) col.append(el("div", "empty-line", "Nothing here yet."));
    for (const c of members) col.append(node(c, selected, chain));
    cols.append(col);
  }
  if (closer) {
    const col = el("section", "map-col map-col-closer");
    const head = el("div", "map-col-head");
    head.append(el("span", "", "Closer"), el("span", "count", closer.state === "landed" ? "1/1" : "0/1"));
    col.append(head, node(closer, selected, chain));
    cols.append(col);
  }
  if (!zones.length) cols.append(el("div", "placeholder", "No zones yet. Add one on the Operation page or with /holotable zone <name>."));
  canvas.append(cols);
  root.append(canvas);
}

export function renderHistory(root, entries, filter) {
  root.replaceChildren();
  const shown = entries.filter(
    (e) =>
      (!filter.contact || e.contact === filter.contact) &&
      (filter.actor === "all" || e.actor === filter.actor) &&
      (!filter.text || e.text.toLowerCase().includes(filter.text.toLowerCase())),
  );
  if (!shown.length) {
    root.append(el("div", "empty-line", entries.length ? "No events match." : "No events yet."));
    return;
  }
  const list = el("ol", "history");
  let day = "";
  for (const e of shown.slice(0, 500)) {
    const d = new Date(e.at).toDateString();
    if (d !== day) {
      day = d;
      list.append(el("li", "day", d === new Date().toDateString() ? "Today" : d));
    }
    const li = el("li", `h ${e.cls}`);
    li.append(el("time", "", clock(e.at)), el("span", `actor a-${e.actor}`, ACTOR_WORD[e.actor] ?? e.actor));
    if (e.contact) {
      const btn = el("button", "linkish", e.text);
      btn.type = "button";
      btn.dataset.id = e.contact;
      li.append(btn);
    } else li.append(el("span", "", e.text));
    list.append(li);
  }
  if (shown.length > 500) list.append(el("li", "day", `${shown.length - 500} older entries hidden; filter to narrow down`));
  root.append(list);
}
