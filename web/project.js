// A project: one repo and the settings every operation on it starts from (GET/POST
// /api/project-config). Operations inherit these and override only what differs.
import { el } from "./components.js";
import { enumRow, switchRow, textRow } from "./fields.js";
import { icon } from "./icons.js";

const titleCase = (kind) => `${kind[0].toUpperCase()}${kind.slice(1)}`;
const WORKSPACE_SOURCE = {
  "orca-project": "from the Orca project",
  operation: "set on the operation",
  settings: "from the board's worktree folder setting",
  none: "not decided by holotable",
};

function section(title, note) {
  const box = el("section", "opdoc-sec");
  const head = el("div", "group-head");
  head.append(el("span", "", title));
  box.append(head);
  if (note) box.append(el("div", "set-note sec-note", note));
  return box;
}

export function renderProject(root, cfg, operations, ctx) {
  root.replaceChildren();
  if (!cfg) {
    root.append(el("div", "empty-line", "Loading the project…"));
    return;
  }
  if (cfg.error) {
    root.append(el("div", "set-err big", cfg.error));
    return;
  }
  const f = cfg.fields;
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", f.name), el("span", "mono opdoc-id", ctx.projectId), el("span", "tag", "project"));
  root.append(head, el("div", "set-note", `${f.repo} · lands on ${f.base}`));

  const ops = section("Operations", "Campaigns on this project. Each one inherits the settings below.");
  const list = el("div", "proj-ops");
  if (!operations.length) list.append(el("div", "empty-line", "No open operations."));
  for (const o of operations) {
    const b = el("button", "proj-op");
    b.type = "button";
    b.dataset.key = `proj-op/${o.id}`;
    b.title = `Open ${o.name}`;
    b.append(el("span", "proj-op-name", o.name), el("span", "set-note", `${o.live} live · ${o.queued} queued${o.attention ? ` · ${o.attention} need you` : ""}`));
    b.addEventListener("click", () => ctx.openOperation(o.id));
    list.append(b);
  }
  const newOp = el("button", "btn small primary");
  newOp.type = "button";
  newOp.append(icon("plus", { size: 12 }), document.createTextNode("New operation in this project"));
  newOp.addEventListener("click", () => ctx.newOperation());
  const tools = el("div", "list-tools left");
  tools.append(newOp);
  ops.append(list, tools);
  root.append(ops);

  const setup = section("Settings", "Changing a setting here changes it for every operation that has not overridden it.");
  const grid = el("div", "set-grid");
  textRow(grid, "Name", "name", f.name, ctx.save);
  textRow(grid, "Base branch", "base", f.base, ctx.save, { mono: true });
  textRow(grid, "Repository", "repo", f.repo, ctx.save, { mono: true, note: "The checkout missions branch from." });
  textRow(grid, "Integration checkout", "integration", f.integration, ctx.save, { mono: true, note: "Where Land merges; must be on the base branch, with no uncommitted changes in the merge's paths." });
  setup.append(grid);
  const ports = el("div", "set-grid ports-grid");
  for (const kind of ["tracker", "fleet", "frontend", "delivery"]) enumRow(ports, titleCase(kind), kind, cfg.options[kind], f[kind], ctx.save);
  setup.append(ports);
  switchRow(setup, "Land with failing checks", "ignoreChecks", f.ignoreChecks, ctx.save, { note: "Operations on this project land PRs even when CI checks are red, unless an operation overrides it. GitHub branch protection still applies." });
  switchRow(setup, "Pause gates", "pause", f.pause, ctx.save, { note: "Missions stop at each Pause gate for your approval." });
  textRow(setup, "Worktree folder", "worktreeRoot", f.worktreeRoot ?? "", ctx.save, {
    mono: true,
    placeholder: "use the board default",
    note: "Only for lanes holotable creates itself (herdr, custom). Orca uses its own project's folder.",
  });
  const w = cfg.workspace;
  const ws = el("div", "set-workspace");
  if (w?.path) ws.append(el("span", "mono", `${w.path} · ${WORKSPACE_SOURCE[w.source] ?? w.source}`));
  if (w?.note) ws.append(el("div", "set-note", w.note));
  setup.append(ws);
  root.append(setup, graphSection(cfg.graph, ctx));

  const danger = section("Remove");
  const remove = el("button", "btn danger");
  remove.type = "button";
  remove.append(icon("octagon-x", { size: 13 }), document.createTextNode("Remove project"));
  remove.disabled = operations.length > 0;
  remove.title = operations.length ? "Close or abort its operations first" : "Forget this project (the repo is not touched)";
  remove.addEventListener("click", () => ctx.remove());
  danger.append(remove, el("div", "set-note", "Only possible without open operations. The repository is never touched."));
  root.append(danger);
}

/** The bead-graph Dolt server, when this repo keeps one. The board supervises it; it never runs it. */
function graphSection(graph, ctx) {
  const box = section("Bead graph", "Missions read their bead graph from a Dolt server in this repo. holotable keeps it under a systemd unit that restarts it; no mission pane starts its own.");
  if (!graph || !graph.managed) {
    box.append(el("div", "set-note", graph?.detail ?? "This repo has no server-mode bead database."));
    return box;
  }
  const row = el("div", "proj-op");
  const healthy = graph.reachable === true;
  const pill = el("span", `pill ${healthy ? "s-landed" : "s-blocked"}`, healthy ? "up" : "down");
  row.append(pill, el("span", "mono", graph.unit ?? ""), el("span", "set-note", graph.detail));
  box.append(row);
  const tools = el("div", "list-tools left");
  const action = (label, op, cls) => {
    const b = el("button", `btn small ${cls ?? ""}`);
    b.type = "button";
    b.append(document.createTextNode(label));
    b.addEventListener("click", () => {
      b.disabled = true;
      ctx.graph(op, (error) => {
        b.disabled = false;
        if (error) b.title = error.message;
      });
    });
    tools.append(b);
  };
  if (graph.unitState === "missing") action("Install", "install", "primary");
  else action("Restart", "restart", "");
  box.append(tools);
  if (graph.managed && !graph.autoStartDisabled)
    box.append(el("div", "set-note", "bd auto-start is still on: a pane can start a copy the Orca reaper will kill. Install turns it off."));
  return box;
}
