// Labelled settings rows shared by the settings drawer, the operation page and the
// new-operation form: a title, one control, an optional note and an inline error line.
// `save(key, value, done)` is supplied by the caller; a non-null error reverts and shows.
import { dropdown, el, numberField, switcher, textField } from "./components.js";

/** One labelled row: title, control, optional note, inline error line. */
export function field(parent, title, control, { note = null, restart = false } = {}) {
  const row = el("div", "set-field");
  const head = el("div", "set-field-head");
  head.append(el("span", "set-name", title));
  if (restart) head.append(el("span", "set-restart", "takes effect after restart"));
  row.append(head);
  const slot = el("div", "set-control");
  slot.append(control);
  row.append(slot);
  let noteEl = null;
  if (note) {
    noteEl = el("div", "set-note", note);
    row.append(noteEl);
  }
  const err = el("div", "set-err");
  err.hidden = true;
  row.append(err);
  parent.append(row);
  return {
    row,
    setError(error) {
      err.hidden = !error;
      // Store errors name the file ("Invalid settings at /x/settings.json: …"); the row only needs the reason.
      err.textContent = error ? error.message.replace(/^Invalid \w+ at [^:]+: /, "") : "";
    },
  };
}

function saveField(field, save, key, value, done) {
  if (field.row.getAttribute("aria-busy") === "true") return;
  const controls = [...field.row.querySelectorAll("input, button, select, textarea")];
  const disabled = controls.map(control => control.disabled);
  field.row.setAttribute("aria-busy", "true");
  controls.forEach(control => { control.disabled = true; });
  const finish = error => {
    field.row.removeAttribute("aria-busy");
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    done(error);
  };
  try { save(key, value, finish); } catch (error) { finish(error); }
}

/** Text field that saves `save(key, input.value)` on change and reverts on error. */
export function textRow(parent, title, key, initial, save, { note, mono = false, placeholder = "", restart = false } = {}) {
  const tf = textField({ label: title, value: initial, placeholder, spellcheck: false });
  if (mono) tf.input.classList.add("mono");
  const f = field(parent, title, tf.root, { note, restart });
  let committed = initial;
  tf.input.addEventListener("change", () => {
    f.setError(null);
    const next = tf.input.value;
    saveField(f, save, key, next, (error) => {
      if (error) {
        tf.input.value = committed;
        f.setError(error);
      } else {
        committed = next;
        tf.opts.value = next;
      }
    });
  });
  return f;
}

/** Number field that saves on change and reverts on error. */
export function numberRow(parent, title, key, initial, save, opts = {}) {
  const nf = numberField({ label: title, value: initial, ...opts });
  const f = field(parent, title, nf.root, { note: opts.note, restart: opts.restart });
  let committed = initial;
  nf.input.addEventListener("change", () => {
    f.setError(null);
    const next = nf.input.value;
    saveField(f, save, key, next, (error) => {
      if (error) {
        nf.input.value = String(committed);
        f.setError(error);
      } else {
        committed = next;
        nf.opts.value = next;
      }
    });
  });
  return f;
}

/** Enum dropdown that saves on pick and reverts on error. */
export function enumRow(parent, title, key, values, initial, save, { note } = {}) {
  let committed = initial;
  const dd = dropdown({
    label: title,
    options: values.map((v) => ({ value: v, label: v })),
    value: initial,
    onChange: (v) => {
      f.setError(null);
      saveField(f, save, key, v, (error) => {
        if (error) {
          dd.setOptions(values.map((x) => ({ value: x, label: x })), committed);
          f.setError(error);
        } else {
          committed = v;
        }
      });
    },
  });
  const f = field(parent, title, dd.root, { note });
  return f;
}

/** Switch row that saves "true"/"false" and reverts on error. */
export function switchRow(parent, title, key, initial, save, { note } = {}) {
  let f;
  let committed = initial;
  const sw = switcher({
    label: title,
    checked: initial,
    onChange: (v) => {
      f.setError(null);
      saveField(f, save, key, v ? "true" : "false", (error) => {
        if (error) {
          sw.setChecked(committed);
          f.setError(error);
        } else {
          committed = v;
        }
      });
    },
  });
  f = field(parent, title, sw.root, { note });
  return f;
}
