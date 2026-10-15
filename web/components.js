// Hand-rolled controls, no dependencies: dropdown/listbox, switch, segmented, checkbox,
// number field, text field. All theme from CSS variables and carry data-cmp so the board's
// global key handler leaves them alone (they own their keys).
// Every element lands via textContent/attributes, never innerHTML.
import { icon } from "./icons.js";

export const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

// ---- open-popover tracking ----
// Regions re-render on every poll. A rebuild would drop a dropdown's trigger while its
// popover is open, so regions ask first and skip their rebuild while one is up inside them.
const OPEN_POPOVERS = new Set(); // entries { root, pop, close() }

/** True while a dropdown whose trigger lives inside `root` has its popover open. */
export function popoverOpenWithin(root) {
  for (const { root: trigger } of OPEN_POPOVERS) if (root.contains(trigger)) return true;
  return false;
}

/** Close any popover whose trigger lives inside `root` (drawer closing, region teardown). */
export function closePopoversWithin(root, { focus = false } = {}) {
  for (const entry of [...OPEN_POPOVERS]) if (root.contains(entry.root)) entry.close({ focus });
}

let NEXT_ID = 0;

const isPrintable = (key) => key.length === 1 && key !== " ";

/**
 * Button + popover listbox. options: [{value, label, hint?, disabled?}] (a null value is a
 * placeholder row). Keys on the closed button: Enter/Space/Down opens on the current value,
 * Up opens on the last item. Open: Up/Down/Home/End move, letters jump, Enter/Space picks,
 * Esc closes without picking. Focus stays on the trigger; the active row is aria-activedescendant.
 */
export function dropdown(opts) {
  const uid = `dd-${++NEXT_ID}`;
  let options = opts.options ?? [];
  let value = opts.value ?? null;
  let placeholder = opts.placeholder ?? "";
  let active = -1;
  let pop = null;
  let removeListeners = null;
  let typeahead = "";
  let typeTimer = 0;
  let searchFilter = "";
  const root = el("span", `cmp-dd${opts.className ? ` ${opts.className}` : ""}`);
  root.dataset.cmp = "";
  const btn = el("button", "cmp-dd-btn");
  btn.type = "button";
  btn.setAttribute("role", "combobox");
  btn.setAttribute("aria-controls", `${uid}-list`);
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  if (opts.label) btn.setAttribute("aria-label", opts.label);
  const text = el("span", "cmp-dd-text");
  const caret = el("span", "cmp-dd-caret");
  caret.append(icon("chevron-down", { size: 11 }));
  caret.setAttribute("aria-hidden", "true");
  btn.append(text, caret);
  root.append(btn);

  // Footer rows (opts.footers: [{label, icon?, className?, onPick}]) sit after every option and are pickable.
  const footers = opts.footers ?? [];
  const matches = (o) => !searchFilter || (o.label && o.label.toLowerCase().includes(searchFilter)) || String(o.value ?? "").toLowerCase().includes(searchFilter) || (o.meta && o.meta.toLowerCase().includes(searchFilter));
  const enabled = () => {
    const ids = options.map((o, i) => (o.group || o.disabled || !matches(o) ? -1 : i)).filter((i) => i >= 0).slice(0, opts.maxOptions ?? options.length);
    for (let k = 0; k < footers.length; k += 1) ids.push(options.length + k);
    return ids;
  };
  const currentIndex = () => options.findIndex((o) => !o.group && o.value === value);

  function renderButton() {
    const item = options.find((o) => o.value === value);
    text.textContent = item ? item.label : placeholder;
    text.classList.toggle("ph", !item);
    btn.title = item?.hint ?? placeholder;
  }

  function markActive() {
    for (const row of pop.querySelectorAll("[role=option]")) {
      const on = Number(row.dataset.index) === active;
      row.classList.toggle("active", on);
      if (on) row.scrollIntoView({ block: "nearest" });
    }
    if (active >= 0) btn.setAttribute("aria-activedescendant", `${uid}-o${active}`);
    else btn.removeAttribute("aria-activedescendant");
  }

  function setActive(i) {
    active = i;
    markActive();
  }

  function renderList() {
    const list = pop.querySelector("[role=listbox]");
    list.replaceChildren();
    let shown = 0;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (o.group) {
        // A section label: check if any following option before the next group matches
        if (searchFilter) {
          let hasMatch = false;
          for (let j = i + 1; j < options.length && !options[j].group; j++) {
            if (matches(options[j])) { hasMatch = true; break; }
          }
          if (!hasMatch) continue;
        }
        list.append(el("div", "cmp-dd-group", o.label));
        continue;
      }
      if (!matches(o)) continue;
      if (shown >= (opts.maxOptions ?? options.length)) continue;
      shown++;
      const row = el("div", `cmp-dd-opt${o.disabled ? " off" : ""}${o.indent ? " indent" : ""}`);
      row.id = `${uid}-o${i}`;
      row.setAttribute("role", "option");
      row.dataset.index = String(i);
      row.setAttribute("aria-selected", String(o.value === value));
      if (o.disabled) row.setAttribute("aria-disabled", "true");
      if (o.hint) row.title = o.hint;
      row.append(el("span", "cmp-dd-opt-label", o.label));
      if (o.meta) row.append(el("span", "cmp-dd-meta", o.meta));
      row.addEventListener("pointerenter", () => {
        if (!o.disabled) setActive(i);
      });
      list.append(row);
    }
    if (opts.maxOptions && options.filter((o) => !o.group && matches(o)).length > shown) {
      list.append(el("div", "cmp-dd-empty", "Search to find more models"));
    }
    for (const [k, f] of footers.entries()) {
      const index = options.length + k;
      const row = el("div", `cmp-dd-opt cmp-dd-foot${f.className ? ` ${f.className}` : ""}${k === 0 ? " first" : ""}`);
      row.id = `${uid}-o${index}`;
      row.setAttribute("role", "option");
      row.dataset.index = String(index);
      row.setAttribute("aria-selected", "false");
      if (f.icon) row.append(icon(f.icon, { size: 12 }));
      row.append(el("span", "", f.label));
      row.addEventListener("pointerenter", () => setActive(index));
      list.append(row);
    }
    if (!enabled().includes(active)) active = enabled()[0] ?? -1;
    markActive();
  }

  function step(dir) {
    const ids = enabled();
    if (!ids.length) return;
    const at = ids.indexOf(active);
    const next = at === -1 ? (dir > 0 ? ids[0] : ids[ids.length - 1]) : ids[(at + dir + ids.length) % ids.length];
    setActive(next);
  }

  function position() {
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${Math.max(r.width, 140)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    const below = innerHeight - r.bottom;
    const room = Math.min(pop.offsetHeight, below - 8);
    pop.style.top = room >= 120 || below >= r.top ? `${r.bottom + 4}px` : `${Math.max(8, r.top - pop.offsetHeight - 4)}px`;
  }

  function open(at = null) {
    if (pop || btn.disabled) return;
    pop = el("div", "cmp-dd-pop");
    pop.setAttribute("data-popover", "");
    let searchInput = null;
    if (opts.searchable) {
      const wrap = el("div", "cmp-dd-search-wrap");
      searchInput = el("input", "cmp-dd-search");
      searchInput.type = "text";
      searchInput.placeholder = opts.searchPlaceholder ?? "Search…";
      searchInput.setAttribute("aria-label", opts.searchPlaceholder ?? "Search options");
      searchInput.addEventListener("input", () => {
        searchFilter = searchInput.value.trim().toLowerCase();
        renderList();
        const valid = enabled();
        if (!valid.includes(active)) setActive(valid[0] ?? -1);
      });
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          close({ pick: true });
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "Tab") {
          close({ focus: false });
        }
      });
      wrap.append(searchInput);
      pop.append(wrap);
    }
    const list = el("div", "cmp-dd-list");
    list.setAttribute("role", "listbox");
    list.id = `${uid}-list`;
    if (opts.label) list.setAttribute("aria-label", opts.label);
    pop.append(list);
    list.addEventListener("click", (e) => {
      const row = e.target.closest("[role=option]");
      if (!row || row.getAttribute("aria-disabled") === "true") return;
      active = Number(row.dataset.index);
      close({ pick: true });
    });
    document.body.append(pop);
    active = at ?? (currentIndex() >= 0 ? currentIndex() : enabled()[0] ?? -1);
    renderList();
    position();
    if (searchInput) queueMicrotask(() => searchInput.focus());
    btn.setAttribute("aria-expanded", "true");
    opts.onOpen?.();
    const onDocDown = (e) => {
      if (!pop.contains(e.target) && !root.contains(e.target)) close();
    };
    const onShift = () => position();
    document.addEventListener("pointerdown", onDocDown, true);
    addEventListener("resize", onShift);
    addEventListener("scroll", onShift, true);
    removeListeners = () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      removeEventListener("resize", onShift);
      removeEventListener("scroll", onShift, true);
    };
    OPEN_POPOVERS.add({ root, pop, close });
  }

  function close({ focus = true, pick = false } = {}) {
    if (!pop) return;
    const wasActive = active;
    searchFilter = "";
    const gone = pop;
    pop = null;
    gone.remove();
    removeListeners?.();
    removeListeners = null;
    for (const entry of [...OPEN_POPOVERS]) if (entry.pop === gone) OPEN_POPOVERS.delete(entry);
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-activedescendant");
    if (pick && wasActive >= 0) {
      if (wasActive >= options.length) footers[wasActive - options.length]?.onPick();
      else {
        const o = options[wasActive];
        if (o && !o.group && !o.disabled && (o.value !== value || opts.reselect)) {
          value = o.value;
          renderButton();
          opts.onChange?.(o.value);
        }
      }
    }
    if (focus && root.isConnected) btn.focus();
  }

  function typeJump(key) {
    typeahead += key.toLowerCase();
    clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      typeahead = "";
    }, 500);
    const wrap = options.findIndex((o) => !o.group && !o.disabled && matches(o) && o.label.toLowerCase().startsWith(typeahead));
    if (wrap >= 0) setActive(wrap);
  }

  btn.addEventListener("click", () => {
    if (pop) close({ focus: false });
    else open();
  });

  btn.addEventListener("keydown", (e) => {
    if (btn.disabled) return;
    if (pop) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          step(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          step(-1);
          break;
        case "Home":
          e.preventDefault();
          setActive(enabled()[0] ?? -1);
          break;
        case "End":
          e.preventDefault();
          setActive(enabled()[enabled().length - 1] ?? -1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          close({ pick: true });
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          close();
          break;
        case "Tab":
          close({ focus: false });
          break;
        default:
          if (isPrintable(e.key)) {
            e.preventDefault();
            typeJump(e.key);
          }
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        open();
        break;
      case "ArrowUp":
        e.preventDefault();
        open(enabled()[enabled().length - 1] ?? -1);
        break;
      default:
        if (isPrintable(e.key)) {
          e.preventDefault();
          open();
          typeJump(e.key);
        }
    }
  });

  renderButton();
  return {
    root,
    btn,
    get value() {
      return value;
    },
    get open() {
      return pop !== null;
    },
    /** Replace options; an open popover stays open and re-lists in place. */
    setValue(next) {
      value = next;
      renderButton();
      if (pop) {
        const keep = currentIndex();
        if (keep >= 0) active = keep;
        renderList();
      }
    },
    setOptions(next, nextValue = value, nextPlaceholder = placeholder) {
      const same =
        nextValue === value &&
        nextPlaceholder === placeholder &&
        next.length === options.length &&
        next.every(
          (o, i) => o.value === options[i].value && o.label === options[i].label && o.meta === options[i].meta && o.hint === options[i].hint && Boolean(o.disabled) === Boolean(options[i].disabled),
        );
      if (same) return;
      options = next;
      value = nextValue;
      placeholder = nextPlaceholder;
      renderButton();
      if (pop) {
        const keep = currentIndex();
        if (keep >= 0) active = keep;
        renderList();
        position();
      }
    },
    setDisabled(flag) {
      btn.disabled = Boolean(flag);
      if (flag) close({ focus: false });
    },
    close: () => close(),
  };
}

/** role=switch button; fires onChange(checked). */
export function switcher(opts) {
  const btn = el("button", `cmp-sw${opts.className ? ` ${opts.className}` : ""}`);
  btn.type = "button";
  btn.dataset.cmp = "";
  btn.setAttribute("role", "switch");
  if (opts.label) btn.setAttribute("aria-label", opts.label);
  btn.append(el("span", "cmp-sw-knob"));
  let value = Boolean(opts.checked);
  const paint = () => {
    btn.setAttribute("aria-checked", String(value));
    btn.classList.toggle("on", value);
  };
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    value = !value;
    paint();
    opts.onChange?.(value);
  });
  paint();
  return {
    root: btn,
    btn,
    setChecked(next) {
      value = Boolean(next);
      paint();
    },
  };
}

/** Radiogroup with arrow-key roaming; fires onChange(value). */
export function segmented(opts) {
  const root = el("div", `cmp-seg${opts.className ? ` ${opts.className}` : ""}`);
  root.dataset.cmp = "";
  root.setAttribute("role", "radiogroup");
  if (opts.label) root.setAttribute("aria-label", opts.label);
  let value = opts.value;
  let buttons = [];

  function paint() {
    for (const b of buttons) {
      const on = b.dataset.value === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!buttons.some((b) => b.tabIndex === 0) && buttons.length) buttons[0].tabIndex = 0;
  }

  function choose(v, { fire = true } = {}) {
    if (v === value) return;
    value = v;
    paint();
    if (fire) opts.onChange?.(v);
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-value]");
    if (b && !b.disabled) {
      choose(b.dataset.value);
      b.focus();
    }
  });
  root.addEventListener("keydown", (e) => {
    const ids = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in ids) && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement);
    const i =
      e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + ids[e.key] + buttons.length) % buttons.length;
    buttons[i]?.focus();
    if (buttons[i] && !buttons[i].disabled) choose(buttons[i].dataset.value);
  });

  function setOptions(next) {
    buttons = [];
    root.replaceChildren();
    for (const o of next) {
      const b = el("button", "cmp-seg-btn", o.label);
      b.type = "button";
      b.dataset.cmp = "";
      b.dataset.value = o.value;
      b.setAttribute("role", "radio");
      b.disabled = Boolean(o.disabled);
      if (o.hint) b.title = o.hint;
      buttons.push(b);
      root.append(b);
    }
    paint();
  }
  setOptions(opts.options ?? []);

  return {
    root,
    get value() {
      return value;
    },
    setValue(next) {
      choose(next, { fire: false });
    },
  };
}

function stepper(iconName, dir, input, step) {
  const b = el("button", "cmp-num-step");
  b.append(icon(iconName, { size: 12 }));
  b.type = "button";
  b.dataset.cmp = "";
  b.tabIndex = -1;
  b.setAttribute("aria-hidden", "true");
  b.addEventListener("click", () => {
    input.value = String((Number(input.value) || 0) + dir * step);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return b;
}

/** Number input with stepper buttons; commits via `change` on blur/Enter/stepper. */
export function numberField(opts) {
  const step = opts.step ?? 1;
  const root = el("span", `cmp-num${opts.className ? ` ${opts.className}` : ""}`);
  const input = el("input", "cmp-num-input");
  input.type = "number";
  input.dataset.cmp = "";
  if (opts.label) input.setAttribute("aria-label", opts.label);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.step = String(step);
  input.value = String(opts.value ?? "");
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = String(opts.value ?? "");
      input.blur();
    }
  });
  // Typed values snap into range before any caller's change handler sees them.
  input.addEventListener("change", () => {
    const n = Number(input.value);
    if (input.value === "" || Number.isNaN(n)) return;
    if (opts.max !== undefined && n > opts.max) input.value = String(opts.max);
    if (opts.min !== undefined && n < opts.min) input.value = String(opts.min);
  });
  root.append(stepper("minus", -1, input, step), input, stepper("plus", 1, input, step));
  return { root, input, opts };
}

/** Text input that commits on blur/Enter (Esc restores the last committed value). */
export function textField(opts) {
  const input = el("input", `cmp-text${opts.className ? ` ${opts.className}` : ""}`);
  input.type = "text";
  input.dataset.cmp = "";
  if (opts.label) input.setAttribute("aria-label", opts.label);
  input.value = opts.value ?? "";
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.spellcheck === false) input.spellcheck = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      e.stopPropagation();
      input.value = opts.value ?? "";
      input.blur();
    }
  });
  return { root: input, input, opts };
}

/**
 * Text input with suggestions (role=combobox). `source(query)` returns (or resolves to)
 * `[{value, label, hint?, meta?, disabled?}]`; it is debounced and stale answers are dropped.
 * Arrows move, Enter or click picks (`onPick(item)`), Esc closes. Typing freely is still allowed:
 * the value is whatever is in the input unless a pick replaces it.
 */
export function combobox(opts) {
  const uid = `cmb-${Math.random().toString(36).slice(2, 8)}`;
  const root = el("div", "cmp-combo");
  const input = el("input", `cmp-text${opts.mono ? " mono" : ""}`);
  input.type = "text";
  input.dataset.cmp = "";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", `${uid}-list`);
  if (opts.label) input.setAttribute("aria-label", opts.label);
  if (opts.placeholder) input.placeholder = opts.placeholder;
  root.append(input);
  let pop = null;
  let items = [];
  let active = -1;
  let seq = 0;
  let timer = 0;
  let note = "";

  // `opts.anchor` (e.g. a chips box around the input) keeps the list still while the input moves inside it.
  function position() {
    if (!pop) return;
    const r = (opts.anchor ?? input).getBoundingClientRect();
    pop.style.width = `${Math.max(r.width, 200)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const flip = below < 160 && above > below;
    pop.style.maxHeight = `${Math.min(280, flip ? above : below)}px`;
    pop.style.top = flip ? `${Math.max(8, r.top - pop.offsetHeight - 4)}px` : `${r.bottom + 4}px`;
  }
  function onDocDown(e) {
    if (pop && !pop.contains(e.target) && !root.contains(e.target) && !opts.anchor?.contains(e.target)) close();
  }
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", onDocDown, true);
    removeEventListener("scroll", position, true);
  }
  function setActive(i) {
    active = i;
    if (!pop) return;
    for (const row of pop.querySelectorAll("[role=option]")) row.classList.toggle("active", Number(row.dataset.index) === i);
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", `${uid}-o${i}`);
      const row = pop.querySelector(`#${uid}-o${i}`);
      if (row) {
        if (row.offsetTop < pop.scrollTop) pop.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > pop.scrollTop + pop.clientHeight) pop.scrollTop = row.offsetTop + row.offsetHeight - pop.clientHeight;
      }
    } else input.removeAttribute("aria-activedescendant");
  }
  function render() {
    if (!items.length && !note) return close();
    if (!pop) {
      pop = el("div", "cmp-dd-pop cmp-combo-pop");
      pop.setAttribute("data-popover", "");
      document.body.append(pop);
      document.addEventListener("pointerdown", onDocDown, true);
      addEventListener("scroll", position, true);
      input.setAttribute("aria-expanded", "true");
    }
    const list = el("div", "cmp-dd-list");
    list.id = `${uid}-list`;
    list.setAttribute("role", "listbox");
    for (const [i, it] of items.entries()) {
      const row = el("div", `cmp-dd-opt cmp-combo-opt${it.disabled ? " off" : ""}`);
      row.id = `${uid}-o${i}`;
      row.dataset.index = String(i);
      row.setAttribute("role", "option");
      if (it.disabled) row.setAttribute("aria-disabled", "true");
      row.append(el("span", "cmp-combo-label", it.label));
      if (it.meta) row.append(el("span", "cmp-combo-meta", it.meta));
      if (it.hint) row.title = it.hint;
      row.addEventListener("pointerenter", () => !it.disabled && setActive(i));
      row.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input
      row.addEventListener("click", () => pick(i));
      list.append(row);
    }
    if (note) list.append(el("div", "cmp-dd-group cmp-combo-note", note));
    pop.replaceChildren(list);
    setActive(items.findIndex((it) => !it.disabled));
    position();
  }
  function pick(i) {
    const it = items[i];
    if (!it || it.disabled) return;
    close();
    opts.onPick?.(it);
  }
  async function query() {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < (opts.minChars ?? 1)) {
      items = [];
      note = opts.hintEmpty && document.activeElement === input ? opts.hintEmpty : "";
      return render();
    }
    if (opts.loading) {
      note = opts.loading;
      if (!items.length) render();
    }
    let result;
    try {
      result = await opts.source(q);
    } catch (error) {
      if (mine !== seq) return;
      items = [];
      note = error instanceof Error ? error.message : String(error);
      return render();
    }
    if (mine !== seq || document.activeElement !== input) return;
    items = Array.isArray(result) ? result : result.items;
    note = (!Array.isArray(result) && result.note) || (items.length ? "" : (opts.empty ?? "No matches"));
    render();
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(query, opts.debounce ?? 200);
  });
  input.addEventListener("focus", () => query());
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!pop) return query();
      const step = e.key === "ArrowDown" ? 1 : -1;
      for (let i = active + step; i >= 0 && i < items.length; i += step)
        if (!items[i].disabled) return setActive(i);
    } else if (e.key === "Enter" && pop && active >= 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
    } else if (e.key === "Escape" && pop) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  return { root, input, close, refresh: query };
}
