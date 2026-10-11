// What defines a project: a repo, and the base branch and wiring detected from it (POST
// /api/projects/detect). The operator picks a repo; everything else is filled in with a reason
// and stays one "Adjust" away. Used by the Projects page, a standalone operation, and Start a campaign.
import { combobox, dropdown, el, switcher, textField } from "./components.js";
import { field } from "./fields.js";
import { icon } from "./icons.js";
import { fetchJson, titleCase } from "./ui.js";

export const PORT_OPTIONS = {
  tracker: ["linear", "github", "none"],
  fleet: ["omp-mission", "none"],
  frontend: ["orca", "herdr", "custom", "none"],
  delivery: ["github-pr", "local-merge", "none"],
};
const PORTS = ["tracker", "fleet", "frontend", "delivery"];
const SOURCE = { orca: "Orca", project: "project", session: "omp session" };
const FIELD_LABEL = { base: "Base branch", tracker: "Tracker", frontend: "Panes", delivery: "Lands by", name: "Name" };

let reposCache = null;
/** GET /api/repos once per page; the list barely changes while someone fills a form. */
export function knownRepos(api) {
  reposCache ??= api("/api/repos").then(fetchJson).catch(() => []);
  return reposCache;
}

/** A combobox over known repos (Orca's, existing projects', the omp session's) that also takes a typed path. */
export function repoPicker(api, { onPick, placeholder = "Pick a repo or type its path" } = {}) {
  const picker = combobox({
    label: "Repository",
    mono: true,
    placeholder,
    minChars: 0,
    debounce: 0,
    empty: "No known repo matches; an absolute path works too.",
    source: async (q) => {
      const needle = q.toLowerCase();
      const repos = await knownRepos(api);
      return repos
        .filter((r) => !needle || r.path.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))
        .slice(0, 30)
        .map((r) => ({ value: r.path, label: `${r.name}  ${r.path}`, meta: SOURCE[r.source] ?? r.source }));
    },
    onPick: (it) => {
      picker.input.value = it.value;
      onPick?.(it.value);
    },
  });
  // A typed path counts once the field is left.
  picker.input.addEventListener("change", () => {
    const v = picker.input.value.trim();
    if (v.startsWith("/")) onPick?.(v);
  });
  return picker;
}

/**
 * Returns `{ box, repoValue(), read(), clearErrors(), ready() }`. `read()` returns the settings or null
 * after marking the bad field; `ready()` resolves once detection for the current repo has finished.
 */
export function projectFields(defaults, api) {
  const box = el("div", "pf");
  let detecting = Promise.resolve();
  let detectedFor = "";

  const picker = repoPicker(api, { onPick: (repo) => detect(repo) });
  const repoF = field(box, "Repository *", picker.root, { note: "The git checkout missions branch from." });

  const summary = el("div", "detect-summary");
  summary.hidden = true;
  box.append(summary);

  const adjust = el("div", "pf-adjust");
  adjust.hidden = true;
  const grid = el("div", "set-grid");
  const base = textField({ label: "Base branch", placeholder: "main", spellcheck: false });
  base.input.classList.add("mono");
  const baseF = field(grid, "Base branch *", base.root, { note: "Where completed work lands." });
  const integ = textField({ label: "Integration checkout", placeholder: "defaults to the repository", spellcheck: false });
  integ.input.classList.add("mono");
  field(grid, "Integration checkout", integ.root, { note: "Optional: a different checkout Land merges on." });
  const portGrid = el("div", "set-grid ports-grid");
  const ports = {};
  for (const kind of PORTS) {
    ports[kind] = dropdown({ label: titleCase(kind), options: PORT_OPTIONS[kind].map((v) => ({ value: v, label: v })), value: defaults?.[kind] ?? "none" });
    field(portGrid, titleCase(kind), ports[kind].root, {});
  }
  const pause = switcher({ label: "Pause gates", checked: true });
  adjust.append(grid, portGrid);
  field(adjust, "Pause gates", pause.root, { note: "Missions stop at each Pause gate for your approval." });
  box.append(adjust);

  const toggle = el("button", "linkish pf-toggle");
  toggle.type = "button";
  const setOpen = (open) => {
    adjust.hidden = !open;
    toggle.replaceChildren(icon("settings", { size: 12 }), document.createTextNode(open ? "Hide settings" : "Adjust"));
  };
  toggle.addEventListener("click", () => setOpen(adjust.hidden));

  function showSummary(fields, reasons) {
    summary.replaceChildren();
    const list = el("dl", "detect-list");
    for (const key of ["base", "tracker", "frontend", "delivery"]) {
      const row = el("div", "");
      row.append(el("dt", "", FIELD_LABEL[key]), el("dd", "mono", String(fields[key])));
      if (reasons?.[key]) row.append(el("dd", "set-note", reasons[key]));
      list.append(row);
    }
    summary.append(list, toggle);
    if (fields.frontend === "none")
      summary.append(el("div", "set-warn", "No terminal frontend found: missions cannot launch until you pick Orca, herdr or a custom one under Adjust."));
    summary.hidden = false;
  }

  function detect(repo) {
    if (!repo || repo === detectedFor) return detecting;
    detectedFor = repo;
    repoF.setError(null);
    summary.hidden = false;
    summary.replaceChildren(el("div", "set-note", "Looking at the repo…"));
    detecting = api("/api/projects/detect", { method: "POST", body: JSON.stringify({ repo }) })
      .then(fetchJson)
      .then(({ fields, reasons }) => {
        if (detectedFor !== repo) return;
        picker.input.value = fields.repo ?? repo;
        base.input.value = fields.base ?? "";
        integ.input.value = fields.integration && fields.integration !== (fields.repo ?? repo) ? fields.integration : "";
        for (const kind of PORTS) if (fields[kind]) ports[kind].setValue(fields[kind]);
        pause.setChecked(fields.pause !== false);
        showSummary(fields, reasons);
        box.dispatchEvent(new CustomEvent("detected", { detail: fields }));
      })
      .catch((error) => {
        if (detectedFor !== repo) return;
        detectedFor = "";
        summary.hidden = true;
        repoF.setError(error instanceof Error ? error : new Error(String(error)));
      });
    return detecting;
  }
  setOpen(false);

  return {
    box,
    picker,
    repoValue: () => picker.input.value.trim(),
    ready: () => detecting,
    clearErrors() {
      repoF.setError(null);
      baseF.setError(null);
    },
    read() {
      const out = { repo: picker.input.value.trim(), base: base.input.value.trim() };
      if (!out.repo.startsWith("/")) {
        repoF.setError(new Error("required: pick a repo or type an absolute path"));
        return null;
      }
      if (!out.base) {
        setOpen(true);
        baseF.setError(new Error("required"));
        return null;
      }
      if (integ.input.value.trim()) out.integration = integ.input.value.trim();
      out.pause = pause.root.getAttribute("aria-checked") === "true";
      for (const kind of PORTS) out[kind] = ports[kind].value;
      return out;
    },
  };
}
