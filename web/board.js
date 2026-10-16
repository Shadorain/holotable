// Board view's right column: execution progress, notes and wiring.
import { notesPanel } from "./notes.js";
import { el } from "./ui.js";

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
