// Error inbox: every error toast also lands here so the toast can go away on its own.
// Header bell with an unread count, hidden while empty; the panel lists errors newest
// first. Kept in memory for this page only.
import { el } from "./components.js";
import { icon } from "./icons.js";
import { clock, trapTab } from "./ui.js";

/** The inbox's contents: newest first, with how many arrived since it was last opened. */
export function errorLog() {
  let entries = [];
  let unread = 0;
  return {
    add(text, at) {
      entries.unshift({ text, at });
      unread++;
    },
    read() {
      unread = 0;
    },
    clear() {
      entries = [];
      unread = 0;
    },
    get entries() {
      return entries;
    },
    get unread() {
      return unread;
    },
  };
}

/** Wire the header bell and its panel; returns `add(text)` for the toast code. */
export function installInbox({ button, count, panel, list, clear, fallbackFocus }) {
  const log = errorLog();
  button.prepend(icon("bell", { size: 16 }));

  function render() {
    button.hidden = log.entries.length === 0;
    count.hidden = log.unread === 0;
    count.textContent = log.unread > 99 ? "99+" : String(log.unread);
    button.setAttribute("aria-label", log.unread ? `Errors, ${log.unread} unread` : "Errors");
    list.replaceChildren(
      ...log.entries.map(({ text, at }) => {
        const item = el("li", "inbox-item");
        item.append(el("time", "inbox-time mono", clock(at, { seconds: true })), el("span", "inbox-text", text));
        return item;
      }),
    );
  }

  function open() {
    // The header wraps on narrow screens, so the panel hangs from wherever the bell is.
    panel.style.top = `${Math.round(button.getBoundingClientRect().bottom + 6)}px`;
    log.read();
    render();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    panel.focus();
  }

  function close({ refocus = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) (button.hidden ? fallbackFocus : button).focus();
  }

  button.addEventListener("click", () => (panel.hidden ? open() : close()));
  clear.addEventListener("click", () => {
    log.clear();
    render();
    close();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return trapTab(panel, e);
    // The board's own Escape (clear notices, blur) must not also run behind the panel.
    e.stopPropagation();
    close();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.contains(e.target) && !button.contains(e.target)) close({ refocus: false });
  });

  return {
    add(text) {
      log.add(text, Date.now());
      if (!panel.hidden) log.read();
      render();
    },
  };
}
