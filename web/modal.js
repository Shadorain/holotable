// Centered modal: scrim, focus trap, Esc and backdrop close. Content is built with DOM nodes
// by the caller; `step(...)` swaps the body and buttons so a flow can take several screens.
import { el } from "./components.js";
import { icon } from "./icons.js";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']";

export function openModal({ title, tone = "", onClose } = {}) {
  const back = el("div", "modal-back");
  const box = el("div", `modal${tone ? ` ${tone}` : ""}`);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  const head = el("div", "modal-head");
  const h = el("h2", "", title);
  h.id = `modal-${Math.random().toString(36).slice(2)}`;
  box.setAttribute("aria-labelledby", h.id);
  const x = el("button", "icon-btn modal-x");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.append(icon("x", { size: 14 }));
  head.append(h, x);
  const body = el("div", "modal-body");
  const foot = el("div", "modal-foot");
  box.append(head, body, foot);
  back.append(box);
  const returnTo = document.activeElement;

  const close = () => {
    document.removeEventListener("keydown", onOutsideKey, true);
    back.remove();
    if (returnTo?.isConnected) returnTo.focus();
    onClose?.();
  };
  // Keys inside the dialog reach their target first (comboboxes and dropdowns claim Enter, arrows and
  // Escape), then stop here on the way out so board shortcuts never fire behind the modal.
  function onInsideKey(e) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      const items = [...box.querySelectorAll(FOCUSABLE)];
      if (items.length) {
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    e.stopPropagation();
  }
  // Focus outside the dialog (the page body, a popover): Esc closes, everything else is swallowed.
  function onOutsideKey(e) {
    if (box.contains(e.target) || e.target.closest?.("[data-popover]")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      box.querySelector(FOCUSABLE)?.focus();
    }
    e.stopPropagation();
  }
  x.addEventListener("click", close);
  back.addEventListener("pointerdown", (e) => {
    if (e.target === back) close();
  });
  box.addEventListener("keydown", onInsideKey);
  document.addEventListener("keydown", onOutsideKey, true);
  document.body.append(back);

  /** Replace the content: `nodes` for the body, `buttons` already built by the caller. */
  function step(nodes, buttons, focus) {
    body.replaceChildren(...nodes);
    foot.replaceChildren(...buttons);
    (focus ?? buttons.at(-1) ?? x).focus();
  }
  return { step, close, box };
}

export function modalButton(label, { iconName, kind = "", onClick } = {}) {
  const b = el("button", `btn${kind ? ` ${kind}` : ""}`);
  b.type = "button";
  if (iconName) b.append(icon(iconName, { size: 13 }));
  b.append(document.createTextNode(label));
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
