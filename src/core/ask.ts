import type { AskData, AskForm, AskValue, ChoiceFormField, FormBlock, FormField, FormSection, FormSpan, FormSpanStyle, MissionAsk, TextFormField } from "./types.ts";
import { isRecord } from "./validate.ts";

/** One `ask` object never exceeds 256 KiB serialized (UTF-8 bytes), per the wire contract. */
export const MAX_ASK_JSON = 256 * 1024;
/** At most 100 named fields per form, per the wire contract. */
export const MAX_ASK_FIELDS = 100;

const SPAN_STYLES: Record<string, FormSpanStyle> = { code: "code", strong: "strong", em: "em" };

const bool = (raw: unknown): raw is boolean => typeof raw === "boolean";
const str = (raw: unknown): raw is string => typeof raw === "string";
const int = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw);

function spans(raw: unknown): FormSpan[] | null {
  if (!Array.isArray(raw)) return null;
  const out: FormSpan[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== "string" ||
        (item.style !== undefined && SPAN_STYLES[item.style as string] === undefined))
      return null;
    const span: FormSpan = { text: item.text };
    if (item.style !== undefined) span.style = SPAN_STYLES[item.style as string]!;
    out.push(span);
  }
  return out;
}

function field(raw: unknown): FormField | null {
  if (!isRecord(raw)) return null;
  const label = spans(raw.label);
  if (label === null || typeof raw.name !== "string" || !raw.name || typeof raw.required !== "boolean") return null;
  if (raw.kind === "choice") {
    if (!Array.isArray(raw.options) || raw.options.length === 0 ||
        !bool(raw.multi) || !bool(raw.select) || !bool(raw.other))
      return null;
    const options: ChoiceFormField["options"] = [];
    for (const o of raw.options) {
      if (!isRecord(o) || typeof o.value !== "string" || typeof o.checked !== "boolean" || typeof o.disabled !== "boolean") return null;
      const optionLabel = spans(o.label);
      if (optionLabel === null) return null;
      options.push({ value: o.value, label: optionLabel, checked: o.checked, disabled: o.disabled });
    }
    const out: ChoiceFormField = {
      kind: "choice", name: raw.name, multi: raw.multi, select: raw.select, other: raw.other,
      label, options, required: raw.required,
    };
    return out;
  }
  if (raw.kind !== "text") return null;
  if (typeof raw.type !== "string" || !raw.type || !bool(raw.multiline) ||
      typeof raw.value !== "string" || typeof raw.placeholder !== "string" ||
      !int(raw.rows) || raw.rows < 1) return null;
  const optInt = (value: unknown): number | undefined | null =>
    value === undefined ? undefined : int(value) && value >= 0 ? value : null;
  const minLength = optInt(raw.minLength);
  const maxLength = optInt(raw.maxLength);
  if (minLength === null || maxLength === null) return null;
  if (raw.min !== undefined && typeof raw.min !== "number") return null;
  if (raw.max !== undefined && typeof raw.max !== "number") return null;
  if (raw.pattern !== undefined && typeof raw.pattern !== "string") return null;
  const out: TextFormField = {
    kind: "text", name: raw.name, type: raw.type, multiline: raw.multiline,
    label, value: raw.value, placeholder: raw.placeholder, required: raw.required, rows: raw.rows,
  };
  if (raw.min !== undefined) out.min = raw.min as number;
  if (raw.max !== undefined) out.max = raw.max as number;
  if (raw.pattern !== undefined) out.pattern = raw.pattern;
  if (minLength !== undefined) out.minLength = minLength;
  if (maxLength !== undefined) out.maxLength = maxLength;
  return out;
}

function block(raw: unknown): FormBlock | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "text": {
      const s = spans(raw.spans);
      return s !== null && bool(raw.heading) ? { kind: "text", spans: s, heading: raw.heading } : null;
    }
    case "list": {
      if (!Array.isArray(raw.items) || !bool(raw.ordered)) return null;
      const items: FormSpan[][] = [];
      for (const item of raw.items) {
        const s = spans(item);
        if (s === null) return null;
        items.push(s);
      }
      return { kind: "list", items, ordered: raw.ordered };
    }
    case "pre":
      return str(raw.text) ? { kind: "pre", text: raw.text } : null;
    case "table": {
      if (!Array.isArray(raw.rows) || !int(raw.headerRows) || raw.headerRows < 0) return null;
      const rows: FormSpan[][][] = [];
      for (const row of raw.rows) {
        if (!Array.isArray(row)) return null;
        const cells: FormSpan[][] = [];
        for (const cell of row) {
          const s = spans(cell);
          if (s === null) return null;
          cells.push(s);
        }
        rows.push(cells);
      }
      return { kind: "table", rows, headerRows: raw.headerRows };
    }
    case "image":
      return str(raw.src) && str(raw.alt) ? { kind: "image", src: raw.src, alt: raw.alt } : null;
    case "svg":
      return str(raw.markup) && str(raw.alt) ? { kind: "svg", markup: raw.markup, alt: raw.alt } : null;
    case "field": {
      const f = field(raw.field);
      if (f === null) return null;
      const out: FormBlock = { kind: "field", field: f };
      if (raw.optionsEnd !== undefined) {
        if (!int(raw.optionsEnd) || raw.optionsEnd < 1) return null;
        out.optionsEnd = raw.optionsEnd;
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * Parse the `ask` of a producer's status: `{id, form}` where `form` mirrors the serializable
 * `HtmlForm` of `@oh-my-pi/pi-tui/html-form/parse`. Lenient like the status `report`: anything
 * off-contract — wrong shapes, missing blocks, a form over the JSON or field bounds, `fields`
 * that are not exactly the field blocks of the sections, duplicate control names — reads as no
 * ask (null), so the question hold survives and the board points the operator at the pane.
 */
export function parseAsk(raw: unknown): MissionAsk | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "" || !isRecord(raw.form)) return null;
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_ASK_JSON) return null;
  const rawForm = raw.form;
  if (!Array.isArray(rawForm.sections) || !Array.isArray(rawForm.fields) ||
      rawForm.fields.length === 0 || rawForm.fields.length > MAX_ASK_FIELDS ||
      !Array.isArray(rawForm.hidden))
    return null;
  const hidden: AskForm["hidden"] = [];
  for (const pair of rawForm.hidden) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !pair[0] || typeof pair[1] !== "string") return null;
    hidden.push([pair[0], pair[1]]);
  }
  const sections: FormSection[] = [];
  const embedded: FormField[] = [];
  for (const s of rawForm.sections) {
    if (!isRecord(s) || typeof s.fieldset !== "boolean" || !Array.isArray(s.blocks)) return null;
    const title = spans(s.title);
    if (title === null) return null;
    const blocks: FormBlock[] = [];
    for (const b of s.blocks) {
      const parsed = block(b);
      if (parsed === null) return null;
      if (parsed.kind === "field") embedded.push(parsed.field);
      blocks.push(parsed);
    }
    sections.push({ title, blocks, fieldset: s.fieldset });
  }
  // `fields` is the same list in document order; mismatch means a hand-rolled or corrupt form.
  const declared: FormField[] = [];
  for (const f of rawForm.fields) {
    const parsed = field(f);
    if (parsed === null) return null;
    declared.push(parsed);
  }
  if (declared.length !== embedded.length || declared.some((f, i) => JSON.stringify(f) !== JSON.stringify(embedded[i]))) return null;
  const names = new Set([...declared.map((f) => f.name), ...hidden.map(([name]) => name)]);
  if (names.size !== declared.length + hidden.length) return null;
  return { id: raw.id, form: { sections, fields: declared, hidden } };
}

/** Plain text of spans, for labels that fall back to a single string. */
export function spansText(list: readonly FormSpan[]): string {
  return list.map((span) => span.text).join("");
}

/**
 * The question each field answers: its own label, else the text block right before it
 * (`<p>Which database?</p>` above a radio group), else its section title, else a lone
 * option's label (a single checkbox), else its name — the native `fieldQuestions` order.
 */
export function askQuestions(form: AskForm): Map<string, string> {
  const questions = new Map<string, string>();
  for (const section of form.sections) {
    const title = spansText(section.title);
    let caption = "";
    for (const b of section.blocks) {
      if (b.kind === "field") {
        const f = b.field;
        const own = spansText(f.label);
        const lone = f.kind === "choice" && f.options.length === 1 ? spansText(f.options[0]!.label) : "";
        questions.set(f.name, (own || caption || title || lone || f.name).replace(/\s+/g, " ").trim());
        caption = "";
        continue;
      }
      caption = b.kind === "text" ? spansText(b.spans) : "";
    }
  }
  return questions;
}

/** The question the board leads the card with: the first field's, as the pane sees it. */
export function askSummary(ask: MissionAsk): string {
  const first = ask.form.fields[0];
  return (first && askQuestions(ask.form).get(first.name)) || "the mission's question";
}

/** `^(?:pattern)$` as HTML matches `pattern`, or undefined when the model wrote an invalid one. */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
}

const isValue = (raw: unknown): raw is AskValue =>
  typeof raw === "string" || typeof raw === "number" ||
  (Array.isArray(raw) && raw.every((item) => typeof item === "string"));

/**
 * Why `raw` is not an acceptable answer for `f` — the board's mirror of the native
 * `fieldError`, plus what only the board can check: unknown values, disabled options
 * and value types. `raw` is already one of string | number | string[] | undefined.
 */
function fieldError(f: FormField, raw: AskValue | undefined): string | undefined {
  if (f.kind === "choice") {
    const enabled = new Set(f.options.filter((o) => !o.disabled).map((o) => o.value));
    const member = (v: string): string | undefined => {
      if (f.options.some((o) => o.disabled && o.value === v)) return "a disabled option";
      if (enabled.has(v)) return undefined;
      return f.other && v.trim() !== "" ? undefined : "an unknown option";
    };
    if (raw === undefined) return f.required ? "Required" : undefined;
    if (f.multi && f.options.length > 1) {
      if (!Array.isArray(raw)) return "an option list";
      if (new Set(raw).size !== raw.length) return "distinct choices";
      if (raw.length === 0) return f.required ? "Select at least one" : undefined;
      const other = raw.filter((v) => !enabled.has(v) && !f.options.some((o) => o.disabled && o.value === v));
      if (other.length > 1) return "one free-text answer";
      for (const v of raw) {
        const bad = member(v);
        if (bad) return bad;
      }
      return undefined;
    }
    if (typeof raw !== "string") return "one option";
    return member(raw) ?? undefined;
  }
  if (raw === undefined) return f.required ? "Required" : undefined;
  const limit = f.maxLength;
  const text = typeof raw === "string" ? raw : typeof raw === "number" && (f.type === "number" || f.type === "range") && Number.isFinite(raw) ? String(raw) : null;
  if (text === null) return `a ${f.type === "number" || f.type === "range" ? "number" : "text answer"}`;
  if (text.trim() === "") return f.required ? "Required" : undefined;
  if (limit !== undefined && text.length > limit) return `At most ${limit} characters`;
  if (f.type === "number" || f.type === "range") {
    const n = Number(text);
    if (!Number.isFinite(n)) return "Enter a number";
    if (f.min !== undefined && n < f.min) return `Must be at least ${f.min}`;
    if (f.max !== undefined && n > f.max) return `Must be at most ${f.max}`;
  }
  if (f.minLength !== undefined && text.length < f.minLength) return `Needs at least ${f.minLength} characters`;
  if (f.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return "Enter an email address";
  if (f.type === "url" && !URL.canParse(text)) return "Enter a full URL";
  if (f.pattern && compilePattern(f.pattern)?.test(text) === false) {
    return `Must match ${f.pattern.length > 40 ? `${f.pattern.slice(0, 39)}…` : f.pattern}`;
  }
  return undefined;
}

/**
 * Check an answer action's `data` against the mission's open ask: every key names a control
 * of the form, hidden inputs are immutable, and each value fits its control (choices only from
 * enabled options plus at most one "Other" text, numbers for number inputs, required answered).
 * The mission checks again when it settles the dialog; this refuses a malformed submit before
 * anything is sent. Returns the data verbatim — numeric `0`, optional omissions and checkbox
 * single-vs-array shape survive — or the refusal reason.
 */
export function askAnswers(ask: MissionAsk, raw: unknown): AskData | string {
  if (!isRecord(raw)) return "data must be a field-to-value object";
  const questions = askQuestions(ask.form);
  const fields = new Map(ask.form.fields.map((f) => [f.name, f] as const));
  const hidden = new Map(ask.form.hidden);
  for (const [name, value] of Object.entries(raw)) {
    const expected = hidden.get(name);
    if (expected !== undefined) {
      if (value !== expected) return `"${name}" does not match the form's hidden value`;
      continue;
    }
    const f = fields.get(name);
    if (f === undefined) return `"${name}" is not a field of this form`;
    if (!isValue(value)) return `${questions.get(f.name) ?? name}: an answer must be text, a number or a list of options`;
    const bad = fieldError(f, value);
    if (bad) return `${questions.get(f.name) ?? name}: ${bad}`;
  }
  for (const f of ask.form.fields) {
    if (!(f.name in raw)) {
      const bad = fieldError(f, undefined);
      if (bad) return `${questions.get(f.name) ?? f.name}: ${bad}`;
    }
  }
  if (new TextEncoder().encode(JSON.stringify({ id: ask.id, data: raw })).byteLength > 1024 * 1024 - 64)
    return "The answer exceeds the control socket's 1 MiB request limit";
  return raw as AskData;
}
