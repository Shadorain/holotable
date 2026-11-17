import { el, errorText, fetchJson } from "./ui.js";

let current;

export function leaseBox(contact, ctx) {
  const key = `${ctx.opId}/${contact.ticket}`;
  if (current?.key !== key) current = { key, report: null, error: "", pending: null };
  const state = current;
  const root = el("div", "");
  const render = () => {
    root.replaceChildren();
    const button = el("button", "btn", state.pending ? "Checking lease…" : "Check session lease");
    button.type = "button";
    button.disabled = !!state.pending;
    button.title = "Read-only ownership snapshot. Never resumes, steals a lock or authorizes a board action.";
    button.addEventListener("click", () => {
      state.error = "";
      state.pending = (async () => {
        try {
          state.report = await fetchJson(await ctx.api(`/api/session-lease?op=${encodeURIComponent(ctx.opId)}&contact=${encodeURIComponent(contact.ticket)}`));
        } catch (error) {
          state.error = errorText(error);
        } finally {
          state.pending = null;
        }
      })();
      render();
    });
    root.append(button);
    if (state.error) root.append(el("p", "set-note error", state.error));
    if (state.report) {
      const report = state.report;
      root.append(el("p", "set-note", `${report.state} · ${new Date(report.checkedAt).toLocaleTimeString()}`));
      if (report.sessionId) root.append(el("div", "mono", report.sessionId));
      root.append(el("p", "set-note", report.detail));
    } else root.append(el("p", "set-note", "Snapshot only; not used to authorize mission actions."));
    if (state.pending) void state.pending.then(render);
  };
  render();
  return root;
}
