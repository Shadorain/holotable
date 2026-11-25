import { icon } from "./icons.js";
import { el } from "./ui.js";

const drafts = new Map();
const text = (spans) => spans.map((span) => span.text).join("");

function appendSpans(root, spans) {
  for (const span of spans) {
    const tag = { code: "code", strong: "strong", em: "em" }[span.style];
    root.append(tag ? el(tag, "", span.text) : document.createTextNode(span.text));
  }
}

function initialData(form) {
  const data = Object.assign(Object.create(null), Object.fromEntries(form.hidden));
  for (const field of form.fields) {
    if (field.kind === "text") {
      data[field.name] = field.value;
    } else {
      const checked = field.options.filter((option) => option.checked && !option.disabled).map((option) => option.value);
      if (field.multi && field.options.length > 1) data[field.name] = checked;
      else if (checked.length) data[field.name] = checked[0];
    }
  }
  return data;
}

/** Only parsed controls and text cross this boundary; model HTML never enters the DOM. */
export function askBox(contact, ctx, opId) {
  const ask = contact.ask;
  if (!ask) return null;
  const action = contact.actions.find((entry) => entry.id === "answer");
  const prefix = `${opId}/${contact.ticket}/`;
  const key = `${prefix}${ask.id}`;
  for (const old of drafts.keys()) if (old.startsWith(prefix) && old !== key) drafts.delete(old);
  let draft = drafts.get(key);
  if (!draft) {
    draft = { data: initialData(ask.form), others: new Set(), otherText: new Map() };
    drafts.set(key, draft);
  }
  const { data } = draft;
  const root = el("form", "decision-box ask-box");
  root.noValidate = true;
  root.append(el("div", "kicker", "The mission asks"));
  const controls = el("fieldset", "ask-controls");
  controls.disabled = !action?.enabled || ctx.busy.has(`${contact.ticket}/*`);
  const error = el("div", "set-note");
  error.setAttribute("role", "alert");
  const rendered = new Set();
  const setValue = (name, value) => {
    if (value === undefined) delete data[name]; else data[name] = value;
    error.textContent = "";
  };
  const renderField = (field) => {
    if (rendered.has(field.name)) return null;
    rendered.add(field.name);
    const box = el("div", "ask-field");
    if (field.kind === "text") {
      const label = el("label", "set-label");
      appendSpans(label, field.label);
      const input = el(field.multiline ? "textarea" : "input", "ask-other");
      const numeric = field.type === "number" || field.type === "range";
      if (!field.multiline) input.type = numeric ? "text" : ["text", "date", "datetime-local", "time", "month", "week", "email", "url", "tel", "password", "search"].includes(field.type) ? field.type : "text";
      if (numeric) input.inputMode = "decimal";
      input.name = field.name;
      input.value = data[field.name] ?? "";
      input.placeholder = field.placeholder;
      input.required = field.required;
      for (const [property, value] of Object.entries({ min: field.min, max: field.max, pattern: field.pattern, minLength: field.minLength })) {
        if (value !== undefined) input[property] = value;
      }
      if (field.multiline) input.rows = Math.min(20, Math.max(1, field.rows));
      const hint = el("div", "set-note");
      const validate = () => {
        let message = input.validationMessage;
        if (!message && input.value.trim() && numeric) {
          const number = Number(input.value);
          if (!Number.isFinite(number)) message = "Enter a number";
          else if (field.min !== undefined && number < field.min) message = `Must be at least ${field.min}`;
          else if (field.max !== undefined && number > field.max) message = `Must be at most ${field.max}`;
        }
        if (!message && field.maxLength !== undefined && input.value.length > field.maxLength) message = `At most ${field.maxLength} characters`;
        input.setAttribute("aria-invalid", String(Boolean(message)));
        hint.textContent = message ? `${message}. You can still send this answer.` : "";
      };
      input.addEventListener("input", () => {
        setValue(field.name, input.value);
        validate();
      });
      validate();
      label.append(input);
      box.append(label, hint);
      return box;
    }
    const name = field.name;
    const many = field.multi && field.options.length > 1;
    const values = () => many ? data[name] ?? [] : data[name] === undefined ? [] : [data[name]];
    if (field.select) {
      const label = el("label", "set-label");
      appendSpans(label, field.label);
      const select = el("select", "ask-other");
      select.name = name;
      select.multiple = field.multi;
      select.setAttribute("aria-label", text(field.label) || field.name);
      select.required = field.required;
      if (!field.multi) {
        const blank = el("option", "", "Choose…");
        blank.value = "";
        blank.selected = data[name] === undefined;
        select.append(blank);
      }
      for (const option of field.options) {
        const node = el("option", "", text(option.label));
        node.value = option.value;
        node.disabled = option.disabled;
        node.selected = values().includes(option.value);
        select.append(node);
      }
      select.addEventListener("change", () => {
        const picked = [...select.selectedOptions].filter((option) => !option.disabled && (field.multi || option.index > 0)).map((option) => option.value);
        setValue(name, many ? picked : picked[0]);
      });
      label.append(select);
      box.append(label);
      return box;
    }
    const group = el("fieldset", "decide-opts");
    if (field.label.length) {
      const legend = el("legend", "");
      appendSpans(legend, field.label);
      group.append(legend);
    }
    const known = new Set(field.options.map((option) => option.value));
    const otherValue = draft.otherText.get(name) ?? values().find((value) => !known.has(value)) ?? "";
    let otherSelected = draft.others.has(name) || Boolean(otherValue);
    const checks = [];
    let otherInput;
    let otherChoice;
    const updateChoices = () => {
      const picked = checks.filter((input) => input.checked && !input.disabled).map((input) => input.value);
      const typed = field.other && otherSelected ? otherInput.value.trim() : "";
      setValue(name, many ? [...picked, ...(typed ? [typed] : [])] : typed || picked[0]);
    };
    for (const option of field.options) {
      const row = el("label", "decide-opt");
      const input = el("input", "decide-radio");
      input.type = field.multi ? "checkbox" : "radio";
      input.name = name;
      input.value = option.value;
      input.disabled = option.disabled;
      input.checked = values().includes(option.value) && !option.disabled;
      checks.push(input);
      input.addEventListener("change", () => {
        if (!field.multi && input.checked && otherInput) {
          otherSelected = false;
          draft.others.delete(name);
          otherChoice.checked = false;
          otherInput.hidden = true;
        }
        updateChoices();
      });
      const label = el("span", "decide-label");
      appendSpans(label, option.label);
      row.append(input, label);
      if (option.checked) row.append(el("span", "tag tag-recommended", "recommended"));
      group.append(row);
    }
    if (field.other) {
      const label = el("label", "decide-opt");
      otherChoice = el("input", "decide-radio");
      otherChoice.type = field.multi ? "checkbox" : "radio";
      otherChoice.name = name;
      otherChoice.checked = otherSelected;
      label.append(otherChoice, el("span", "decide-label", "Other…"));
      otherInput = el("input", "ask-other");
      otherInput.type = "text";
      otherInput.placeholder = "Your own answer";
      otherInput.value = otherValue;
      otherInput.hidden = !otherSelected;
      otherInput.setAttribute("aria-label", `Other answer for ${name}`);
      otherChoice.addEventListener("change", () => {
        otherSelected = otherChoice.checked;
        if (otherSelected) draft.others.add(name); else draft.others.delete(name);
        if (!field.multi && otherSelected) for (const input of checks) input.checked = false;
        otherInput.hidden = !otherSelected;
        if (otherSelected) otherInput.focus();
        updateChoices();
      });
      otherInput.addEventListener("input", () => {
        draft.otherText.set(name, otherInput.value);
        updateChoices();
      });
      group.append(label, otherInput);
    }
    box.append(group);
    return box;
  };
  for (const section of ask.form.sections) {
    const part = el(section.fieldset ? "fieldset" : "div", "ask-section");
    if (section.title.length) {
      const heading = el(section.fieldset ? "legend" : "h3", "");
      appendSpans(heading, section.title);
      part.append(heading);
    }
    for (const block of section.blocks) {
      let node;
      if (block.kind === "field") node = renderField(ask.form.fields.find((field) => field.name === block.field.name));
      else if (block.kind === "text") { node = el(block.heading ? "h4" : "p", ""); appendSpans(node, block.spans); }
      else if (block.kind === "pre") node = el("pre", "", block.text);
      else if (block.kind === "list") {
        node = el(block.ordered ? "ol" : "ul", "");
        for (const item of block.items) { const row = el("li", ""); appendSpans(row, item); node.append(row); }
      } else if (block.kind === "table") {
        node = el("table", "");
        for (const [index, cells] of block.rows.entries()) {
          const row = el("tr", "");
          for (const cell of cells) { const entry = el(index < block.headerRows ? "th" : "td", ""); appendSpans(entry, cell); row.append(entry); }
          node.append(row);
        }
      } else if (block.kind === "image" || block.kind === "svg") {
        const src = block.kind === "svg" ? `data:image/svg+xml,${encodeURIComponent(block.markup)}` : block.src;
        if (/^https?:\/\//i.test(src) || /^data:image\//i.test(src)) {
          node = el("img", "ask-image");
          node.src = src;
          node.alt = block.alt;
          node.referrerPolicy = "no-referrer";
        } else node = el("p", "set-note", block.alt || "Image is available in the mission pane.");
      }
      if (node) part.append(node);
    }
    controls.append(part);
  }
  const send = el("button", "btn primary");
  send.type = "submit";
  send.append(icon("send", { size: 13 }), document.createTextNode("Send answer"));
  controls.append(send);
  root.append(controls, error);
  root.append(el("div", "set-note", action?.enabled ? "Answers this form in the mission pane. Unanswered fields and validation warnings are sent as-is." : `Use Answer in mission${action?.reason ? `: ${action.reason}` : "."}`));
  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (controls.disabled) return;
    const submitted = { ...data };
    for (const field of ask.form.fields) {
      const value = submitted[field.name];
      if (field.kind === "text" && ["number", "range"].includes(field.type) && String(value ?? "").trim() !== "" && Number.isFinite(Number(value))) submitted[field.name] = Number(value);
    }
    controls.disabled = true;
    try {
      const result = await ctx.run(contact.ticket, "answer", { id: ask.id, data: submitted });
      if (result?.ok) drafts.delete(key);
    } finally {
      controls.disabled = !action?.enabled || ctx.busy.has(`${contact.ticket}/*`);
    }
  });
  return root;
}
