// Themed tooltips for anything with a `title` or `data-tip`. The native title is moved to
// data-tip on first hover so the browser's own tooltip never shows; text lands via textContent.
const DELAY_MS = 350;
let tip = null;
let timer = null;
let owner = null;
// Hosts with live content (the Load stat) register a renderer; show() hands them the tip
// element to fill instead of copying data-tip text. refreshTooltip() re-runs it.
const renderers = new WeakMap();
const closers = new WeakMap();

export function setTipRenderer(host, render, onClose = null) {
  renderers.set(host, render);
  if (onClose) closers.set(host, onClose);
}

/** Re-fill the open tooltip (renderer hosts) or re-copy data-tip; safe when none is open. */
export function refreshTooltip() {
  if (!tip || tip.hidden || !owner) return;
  fill(owner);
  place(owner);
}

/** The element currently owning the open tooltip (null when hidden). */
export function tooltipOwner() {
  return tip && !tip.hidden ? owner : null;
}
function tipFor(target) {
  const host = target instanceof Element ? target.closest("[data-tip], [title]") : null;
  if (!host) return null;
  const title = host.getAttribute("title");
  if (title) {
    host.dataset.tip = title;
    host.setAttribute("aria-description", title);
    host.removeAttribute("title");
  }
  return host.dataset.tip ? host : null;
}

function place(host) {
  const r = host.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  const above = r.top - t.height - gap;
  const top = above >= 6 ? above : r.bottom + gap;
  const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 6);
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.dataset.side = above >= 6 ? "top" : "bottom";
}

function show(host) {
  if (!host.isConnected || document.visibilityState !== "visible") return;
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    tip.id = "holotable-tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  tip.textContent = "";
  fill(host);
  tip.hidden = false;
  place(host);
  host.setAttribute("aria-describedby", tip.id);
  owner = host;
}

function hide() {
  clearTimeout(timer);
  timer = null;
  if (tip) tip.hidden = true;
  if (owner) {
    owner.removeAttribute("aria-describedby");
    const close = closers.get(owner);
    owner = null;
    close?.();
  }
}

function fill(host) {
  const render = renderers.get(host);
  tip.replaceChildren();
  if (render) render(tip);
  else tip.textContent = host.dataset.tip;
}

function arm(host) {
  if (host === owner) return;
  hide();
  if (document.visibilityState !== "visible") return;
  timer = setTimeout(() => show(host), DELAY_MS);
}

// Focus tooltips follow keyboard navigation only (Tab and arrows), never focus set by code.
let keyboard = false;

// Touch has no hover: a tap toggles the tip of something that does nothing when tapped,
// and a long press shows a control's tip instead of pressing it.
const LONG_PRESS_MS = 500;
const CONTROLS =
  "button, a[href], input, select, textarea, summary, label, [contenteditable], " +
  "[role=button], [role=tab], [role=switch], [role=option], [role=radio], [role=checkbox], [role=combobox]";
let coarse = null;
let touch = false; // the current gesture is a touch
let tapOwner = null; // whose tip was open when the gesture began, so a second tap closes it
let press = null; // pending long press: { timer, x, y }
let pressed = false; // a long press showed a tip: the click that follows must not fire

const isTouch = (e) => e.pointerType === "touch" || (e.pointerType !== "mouse" && coarse.matches);

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

export function installTooltips() {
  coarse = matchMedia("(pointer: coarse)");
  document.addEventListener("keydown", (e) => {
    // Only the focus move this key itself makes counts as keyboard navigation: focus a dialog or a
    // rebuilt region hands back later (or after "," or Esc) is programmatic and shows no tip.
    if (e.key === "Tab" || e.key.startsWith("Arrow")) {
      keyboard = true;
      setTimeout(() => {
        keyboard = false;
      });
    }
    pressed = false;
  }, true);
  document.addEventListener("pointerdown", (e) => {
    keyboard = false;
    touch = isTouch(e);
    tapOwner = owner;
    pressed = false;
    cancelPress();
    hide();
    if (!touch) return;
    const host = tipFor(e.target);
    if (!host || !e.target.closest(CONTROLS)) return;
    press = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        press = null;
        pressed = true;
        show(host);
      }, LONG_PRESS_MS),
    };
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  }, true);
  document.addEventListener("pointerup", cancelPress, true);
  document.addEventListener("pointercancel", cancelPress, true);
  document.addEventListener("contextmenu", (e) => {
    if (press || pressed) e.preventDefault();
  }, true);
  document.addEventListener("click", (e) => {
    if (pressed) {
      pressed = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // A click answers the control; its tip has done its job.
    if (!touch) return hide();
    const host = tipFor(e.target);
    if (host && !e.target.closest(CONTROLS) && host !== tapOwner) show(host);
  }, true);
  document.addEventListener("pointerover", (e) => {
    if (isTouch(e)) return;
    // A region rebuild can remove the host under a still pointer: its tip would never get a pointerout.
    if (owner && !owner.isConnected) hide();
    const host = tipFor(e.target);
    if (host) arm(host);
    else if (owner || timer) hide();
  });
  document.addEventListener("focusin", (e) => {
    const host = tipFor(e.target);
    if (host && keyboard && e.target.matches(":focus-visible")) arm(host);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  addEventListener("scroll", hide, true);
  addEventListener("resize", hide);
  document.addEventListener("visibilitychange", hide);
}
