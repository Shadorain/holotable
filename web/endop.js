// Ending an operation from its page. Both dialogs start from GET /api/abort-preview. Abort takes two
// confirmations: a summary of what will be destroyed, then typing the operation id. Close is for a
// finished operation: one confirmation listing what it closes, removes, keeps and leaves alone.
// Both archive it; the archive keeps a report (Plan → Archive).
import { el } from "./components.js";
import { icon } from "./icons.js";
import { modalButton, openModal } from "./modal.js";
import { fetchJson, sectionBox } from "./ui.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A dialog's icon list; `item` returns the text box so a line can carry a sub-list. */
function iconList() {
  const list = el("ul", "modal-list");
  const item = (iconName, text, cls = "") => {
    const li = el("li", cls);
    const textBox = el("div", "");
    textBox.append(el("span", "", text));
    li.append(icon(iconName, { size: 14 }), textBox);
    list.append(li);
    return textBox;
  };
  return { list, item };
}

export function abortOperation(op, ctx) {
  const modal = openModal({ title: `Abort ${op.name}?`, tone: "danger" });
  modal.step([el("div", "set-note", "Checking what is running…")], [modalButton("Cancel", { onClick: modal.close })]);

  let cachedPreview = null;
  function renderPreview(preview) {
    const { list, item } = iconList();
    item("circle-x", `Close ${plural(preview.terminals.length, "mission pane")}: running missions stop where they are.`);
    item("git-branch", `Delete ${plural(preview.worktrees.length, "worktree")}.`);
    const dirty = preview.worktrees.filter((w) => w.dirty);
    if (dirty.length) {
      const warn = item("triangle-alert", `${plural(dirty.length, "worktree has", "worktrees have")} uncommitted changes that will be lost:`, "warn");
      const paths = el("ul", "modal-paths mono");
      for (const w of dirty) paths.append(el("li", "", `${w.ticket}  ${w.path}`));
      warn.append(paths);
    }
    item("archive", `Archive the operation (${preview.landed} landed, ${preview.live} started, ${preview.queued} queued). Its report stays under Plan → Archive.`);
    modal.step([el("p", "", "This cannot be undone."), list], [
      modalButton("Cancel", { onClick: modal.close }),
      modalButton("Continue", { kind: "danger", iconName: "octagon-x", onClick: confirmStep }),
    ]);
  }
  ctx.api(`/api/abort-preview?op=${encodeURIComponent(op.id)}`).then(fetchJson).then(
    (preview) => {
      cachedPreview = preview;
      renderPreview(preview);
    },
    (error) => modal.step([el("div", "set-err", `Cannot check the operation: ${error.message}`)], [modalButton("Close", { onClick: modal.close })]),
  );
  function confirmStep() {
    const label = el("label", "modal-confirm");
    label.append(el("span", "", "Type "), el("b", "mono", op.id), el("span", "", " to abort it."));
    const input = el("input", "cmp-text mono");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Operation id");
    const err = el("div", "set-err");
    err.hidden = true;
    const go = modalButton("Abort operation", { kind: "danger primary", iconName: "octagon-x" });
    go.disabled = true;
    input.addEventListener("input", () => {
      go.disabled = input.value !== op.id;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !go.disabled) go.click();
    });
    go.addEventListener("click", async () => {
      go.disabled = true;
      go.lastChild.textContent = "Aborting…";
      err.hidden = true;
      try {
        const data = await fetchJson(await ctx.api("/api/abort", { method: "POST", body: JSON.stringify({ op: op.id, confirm: input.value }) }));
        modal.close();
        ctx.toast(`${op.name} aborted and archived (${data.archived})`, "ok");
        ctx.ended(op.id);
      } catch (error) {
        err.hidden = false;
        err.textContent = error.message;
        go.disabled = input.value !== op.id;
        go.lastChild.textContent = "Abort operation";
      }
    });
    modal.step([label, input, err], [modalButton("Back", { onClick: () => renderPreview(cachedPreview) }), go], input);
  }
}

export function closeOperation(projection, ctx) {
  const op = projection.operation;
  const modal = openModal({ title: `Close ${op.name}?` });
  modal.step([el("div", "set-note", "Checking panes and worktrees…")], [modalButton("Cancel", { onClick: modal.close })]);
  ctx.api(`/api/abort-preview?op=${encodeURIComponent(op.id)}`).then(fetchJson).then(
    (preview) => confirmStep(preview),
    (error) => modal.step([el("div", "set-err", `Cannot check the operation: ${error.message}`)], [modalButton("Close", { onClick: modal.close })]),
  );

  function confirmStep(preview) {
    const does = iconList();
    const panes = preview.terminals;
    if (panes.length) {
      does.item("circle-x", `Closes ${plural(panes.length, "mission pane")}:`).append(el("div", "modal-tickets mono", panes.join(", ")));
    } else does.item("circle-x", "No mission panes are open.");
    const clean = preview.worktrees.filter((w) => !w.dirty);
    const dirty = preview.worktrees.filter((w) => w.dirty);
    does.item("git-branch", clean.length ? `Removes ${plural(clean.length, "clean worktree")}.` : "No clean worktrees to remove.");
    if (dirty.length) {
      const keep = does.item("triangle-alert", `Keeps ${plural(dirty.length, "worktree")} with uncommitted changes:`, "warn");
      const paths = el("ul", "modal-paths mono");
      for (const w of dirty) paths.append(el("li", "", `${w.ticket}  ${w.path}`));
      keep.append(paths);
    }
    does.item("bot", "Turns auto mode and Recovery off.");
    const closer = projection.contacts.some((c) => c.kind === "closer");
    does.item("archive", `Moves the operation to the archive with its report${closer ? " and closer review" : ""}. It leaves the picker; there is no reopen.`);

    const leaves = iconList();
    leaves.item("shield-check", "Git branches, PRs, Linear issues, the base branch and the integration checkout.");

    const err = el("div", "set-err");
    err.hidden = true;
    const go = modalButton("Close and archive", { kind: "primary", iconName: "flag" });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const data = await fetchJson(await ctx.api("/api/close", { method: "POST", body: JSON.stringify({ op: op.id, outcome: "landed" }) }));
        modal.close();
        ctx.toast(`${op.name} closed and archived (${data.archived})`, "ok");
        ctx.ended(op.id, data.archived);
      } catch (error) {
        err.hidden = false;
        err.textContent = error.message;
        go.disabled = false;
      }
    });
    modal.step(
      [el("p", "", "Every contact has landed. Close:"), does.list, el("p", "modal-sub", "Does not touch:"), leaves.list, err],
      [modalButton("Cancel", { onClick: modal.close }), go],
    );
  }
}

/** The bottom of the Operation page. */
export function endSection(projection, ctx) {
  const { root: box } = sectionBox("End the operation", { cls: "opdoc-sec end-sec" });
  const op = projection.operation;
  const all = allLanded(projection);
  const row = el("div", "end-row");

  const close = el("button", "btn");
  close.type = "button";
  close.append(icon("flag", { size: 13 }), document.createTextNode("Close operation"));
  close.disabled = !all;
  close.title = all ? "Archive this finished operation with its report" : "Available once every contact has landed";
  close.addEventListener("click", () => closeOperation(projection, ctx));

  const abort = el("button", "btn danger");
  abort.type = "button";
  abort.append(icon("octagon-x", { size: 13 }), document.createTextNode("Abort operation"));
  abort.title = "Stop every mission, delete the worktrees and archive the operation (asks twice)";
  abort.addEventListener("click", () => abortOperation(op, ctx));

  row.append(close, abort);
  // Touch screens never see a disabled button's tooltip, so the reason is written out too.
  const why = all ? "" : "Close is available once every contact has landed. ";
  box.append(row, el("div", "set-note", `${why}Both archive the operation. Abort also closes running mission panes and deletes their worktrees.`));
  return box;
}

/** Shown on Board and Table once every contact has landed. */
export function doneBanner(projection, ctx) {
  const box = el("div", "done-banner");
  box.append(icon("flag", { size: 15 }));
  const text = el("div", "done-text");
  text.append(el("b", "", "Every contact has landed."), el("span", "", " Close the operation to archive it with its report."));
  const btn = el("button", "btn small primary");
  btn.type = "button";
  btn.dataset.key = "done-close";
  btn.append(document.createTextNode("Close operation"));
  btn.addEventListener("click", () => closeOperation(projection, ctx));
  box.append(text, btn);
  return box;
}

export const allLanded = (projection) => projection.contacts.length > 0 && projection.contacts.every((c) => c.state === "landed");
