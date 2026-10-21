// The operation's markdown scratch pad (GET/PUT /api/notes). Task lines are clickable; the
// header's notes count comes from them. Writes carry the revision they were based on, so two
// tabs (or the model) editing at once get a "stale" answer instead of overwriting each other.
import { el } from "./components.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { errorText, fetchJson } from "./ui.js";

const countsFor = new Map();
const cache = new Map(); // opId -> {text, revision} | {error} | null while loading
const ui = new Map(); // opId -> {editing, draft, error}
const uiOf = (opId) => {
  if (!ui.has(opId)) ui.set(opId, { editing: false, draft: "", error: null });
  return ui.get(opId);
};

/** Signature for region(): rebuild when the text, revision or editing state changes. */
export function notesKey(opId) {
  const c = cache.get(opId);
  const u = ui.get(opId);
  return `${c?.revision ?? (c?.error ? "err" : "none")}:${u?.editing ?? false}:${u?.error ?? ""}`;
}

export async function loadNotes(opId, api) {
  try {
    const res = await api(`/api/notes?op=${encodeURIComponent(opId)}`);
    const data = await fetchJson(res);
    cache.set(opId, data);
  } catch (error) {
    cache.set(opId, { error: errorText(error) });
  }
}

/** Load once per operation, again when its task counts move; `rerender` runs when the text arrives. */
export function ensureNotes(opId, counts, api, rerender) {
  const sig = `${counts?.done}:${counts?.total}`;
  const current = cache.get(opId);
  if (current === null) return; // already loading
  // A failed load is not retried on every poll either: only a change in the counts asks again.
  if (current !== undefined && countsFor.get(opId) === sig) return;
  countsFor.set(opId, sig);
  cache.set(opId, null);
  loadNotes(opId, api).then(rerender);
}

async function save(opId, text, ctx) {
  const current = cache.get(opId);
  const res = await ctx.api("/api/notes", { method: "PUT", body: JSON.stringify({ op: opId, text, base: current?.revision ?? "" }) });
  cache.set(opId, await fetchJson(res));
}

export function notesPanel(opId, ctx, { compact = false } = {}) {
  const box = el("div", "notes-panel");
  const data = cache.get(opId);
  const state = uiOf(opId);
  if (data === undefined || data === null) {
    box.append(el("div", "empty-line", "Loading notes…"));
    return box;
  }
  if (data.error) {
    box.append(el("div", "set-err", `Cannot load notes: ${data.error}`));
    return box;
  }

  if (state.editing) {
    const area = el("textarea", "");
    area.value = state.draft;
    area.spellcheck = true;
    area.dataset.key = `notes/${opId}`;
    area.setAttribute("aria-label", "Operation notes");
    area.placeholder = "## Next\n- [ ] Something to remember\n\nAnything else: links, decisions, follow-ups.";
    area.addEventListener("input", () => {
      state.draft = area.value;
    });
    const tools = el("div", "notes-tools");
    const saveBtn = el("button", "btn small primary");
    saveBtn.type = "button";
    saveBtn.append(icon("save", { size: 12 }), document.createTextNode("Save"));
    const cancel = el("button", "btn small", "Cancel");
    cancel.type = "button";
    const commit = async () => {
      state.error = null;
      try {
        await save(opId, area.value, ctx);
        state.editing = false;
        state.draft = "";
        ctx.toast("Notes saved", "ok");
        ctx.notesChanged();
      } catch (error) {
        state.error = /^stale/.test(error.message) ? "Someone else changed the notes. Copy your text, cancel, and edit again." : error.message;
        ctx.rerender();
      }
    };
    saveBtn.addEventListener("click", commit);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    });
    cancel.addEventListener("click", () => {
      state.editing = false;
      state.error = null;
      ctx.rerender();
    });
    tools.append(saveBtn, cancel, el("span", "set-note", "Ctrl+Enter saves · - [ ] makes a task"));
    box.append(area, tools);
    if (state.error) box.append(el("div", "set-err", state.error));
    return box;
  }

  const text = data.text ?? "";
  if (text.trim()) {
    const onToggle = async (line, done) => {
      const lines = text.split("\n");
      lines[line] = lines[line].replace(/\[( |x|X)\]/, done ? "[x]" : "[ ]");
      try {
        await save(opId, lines.join("\n"), ctx);
        ctx.notesChanged();
      } catch (error) {
        ctx.toast(/^stale/.test(error.message) ? "Notes changed elsewhere; reloaded." : `Cannot save notes: ${error.message}`, "error");
        await loadNotes(opId, ctx.api);
        ctx.rerender();
      }
    };
    box.append(renderMarkdown(text, { onToggle }));
  } else {
    box.append(el("div", "empty-line", compact ? "No notes yet." : "No notes yet: a scratch pad for this operation. Task lines (- [ ]) become checkboxes and count in the header."));
  }
  const tools = el("div", "notes-tools");
  const edit = el("button", "btn small");
  edit.type = "button";
  edit.dataset.key = `notes-edit/${opId}`;
  edit.append(icon("pencil", { size: 12 }), document.createTextNode(text.trim() ? "Edit" : "Write"));
  edit.title = "Edit the operation's notes (markdown)";
  edit.addEventListener("click", () => {
    state.editing = true;
    state.draft = text;
    state.error = null;
    ctx.rerender();
  });
  tools.append(edit);
  box.append(tools);
  return box;
}
