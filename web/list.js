// The contact list both views share, ordered by what the operator should look at first.
import { addContactButton } from "./addcontact.js";
import { allLanded, doneBanner } from "./endop.js";
import { actionButton, el, primaryAction, statePill } from "./ui.js";

const ATTENTION_ORDER = ["hold", "review", "complete", "decision", "offline"];
const FLIGHT_ORDER = ["conflict", "verify", "review", "running", "planning"];
const QUEUE_ORDER = ["ready", "blocked"];

const rank = (order, state) => {
  const i = order.indexOf(state);
  return i === -1 ? order.length : i;
};

/** Sections in display order; the same order drives j/k navigation. */
export function sections(projection) {
  const needs = [];
  const flight = [];
  const queue = [];
  const waiting = [];
  const landed = [];
  for (const c of projection.contacts) {
    if (c.state === "landed") landed.push(c);
    else if (c.attention) needs.push(c);
    else if (c.group === "queue") queue.push(c);
    else if (c.state === "waiting") waiting.push(c);
    else flight.push(c);
  }
  needs.sort((a, b) => rank(ATTENTION_ORDER, a.state) - rank(ATTENTION_ORDER, b.state));
  flight.sort((a, b) => rank(FLIGHT_ORDER, a.state) - rank(FLIGHT_ORDER, b.state));
  queue.sort((a, b) => rank(QUEUE_ORDER, a.state) - rank(QUEUE_ORDER, b.state));
  return {
    groups: [
      { id: "needs", title: "Needs you", items: needs, empty: "Nothing waiting on you." },
      { id: "flight", title: "In flight", items: flight, empty: "No missions running." },
      ...(waiting.length ? [{ id: "waiting", title: "Waiting", items: waiting }] : []),
      { id: "queue", title: "Queue", items: queue, empty: "Queue empty." },
      { id: "landed", title: "Landed", items: landed, collapsible: true },
    ],
  };
}

export function orderedTickets(projection) {
  const { groups } = sections(projection);
  return groups.flatMap((g) => (g.collapsible && !landedOpen() ? [] : g.items.map((c) => c.ticket)));
}

export function landedOpen() {
  return localStorage.getItem("holotable.landedOpen") === "1";
}

function item(contact, selected, ctx) {
  const row = el("div", `item s-${contact.state}${contact.ticket === selected ? " active" : ""}`);
  const main = el("button", "item-main");
  main.type = "button";
  main.dataset.id = contact.ticket;
  main.dataset.key = `sel/${contact.ticket}`;
  main.setAttribute("aria-current", contact.ticket === selected ? "true" : "false");
  main.title = `${contact.ticket}: ${contact.title ?? ""}${contact.detail ? ` · ${contact.detail}` : ""}`;
  const meta = el("div", "item-meta");
  meta.append(statePill(contact.state), el("span", "mono", contact.ticket), el("span", "item-detail", contact.detail));
  main.append(el("div", "item-title", contact.title ?? contact.ticket), meta);
  row.append(main);
  // One-click path for the obvious next step; plan approval waits in the mission pane, so Focus there.
  const next = primaryAction(contact) ?? (contact.attention ? contact.actions.find((a) => a.id === "focus" && a.enabled) : null);
  if (next) row.append(actionButton(contact, next, ctx, "small"));
  return row;
}

export function renderList(root, projection, selected, ctx) {
  root.replaceChildren();
  if (allLanded(projection) && ctx.endCtx) root.append(doneBanner(projection, ctx.endCtx));
  const { groups } = sections(projection);
  for (const group of groups) {
    if (group.collapsible) {
      if (!group.items.length) continue;
      const details = el("details", "group");
      details.open = landedOpen();
      details.dataset.key = "landed";
      const summary = el("summary", "group-head");
      summary.append(el("span", "", group.title), el("span", "count", String(group.items.length)));
      details.append(summary);
      for (const c of group.items) details.append(item(c, selected, ctx));
      details.addEventListener("toggle", () => localStorage.setItem("holotable.landedOpen", details.open ? "1" : "0"));
      root.append(details);
      continue;
    }
    const section = el("section", `group g-${group.id}`);
    const head = el("div", "group-head");
    head.append(el("span", "", group.title));
    if (group.items.length) head.append(el("span", "count", String(group.items.length)));
    section.append(head);
    if (!group.items.length) section.append(el("div", "empty-line", group.empty));
    for (const c of group.items) section.append(item(c, selected, ctx));
    // New tickets join the queue, so the way to add one sits at its foot.
    if (group.id === "queue" && ctx.addContact) {
      const add = addContactButton(ctx.addContact);
      add.classList.add("add-row");
      section.append(add);
    }
    root.append(section);
  }
}
