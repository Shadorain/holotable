import { expect, test } from "bun:test";
import { askAnswers, parseAsk, askSummary } from "../../src/core/ask.ts";
import type { AskForm, MissionAsk } from "../../src/core/types.ts";

const span = (text: string) => [{ text }];

const form: AskForm = {
  sections: [
    {
      title: span("Rollout"),
      fieldset: true,
      blocks: [
        { kind: "text", spans: span("Listen where?"), heading: false },
        {
          kind: "field",
          field: {
            kind: "choice", name: "listen", multi: false, select: false, other: true, required: true, label: [],
            options: [
              { value: "status", label: span("Status only"), checked: true, disabled: false },
              { value: "send", label: span("Status + send"), checked: false, disabled: false },
              { value: "gone", label: span("Removed option"), checked: false, disabled: true },
            ],
          },
        },
        { kind: "text", spans: span("How many workers?"), heading: false },
        {
          kind: "field",
          field: {
            kind: "text", name: "workers", type: "number", multiline: false, required: true,
            label: [], value: "", placeholder: "", min: 0, max: 8, rows: 1,
          },
        },
        {
          kind: "field",
          field: {
            kind: "choice", name: "channels", multi: true, select: false, other: true, required: false, label: span("Channels"),
            options: [
              { value: "ops", label: span("Ops"), checked: false, disabled: false },
              { value: "dev", label: span("Dev"), checked: false, disabled: false },
            ],
          },
        },
        {
          kind: "field",
          field: {
            kind: "text", name: "notes", type: "textarea", multiline: true, required: false,
            label: span("Notes"), value: "", placeholder: "", maxLength: 10, rows: 4,
          },
        },
      ],
    },
  ],
  fields: [
    {
      kind: "choice", name: "listen", multi: false, select: false, other: true, required: true, label: [],
      options: [
        { value: "status", label: span("Status only"), checked: true, disabled: false },
        { value: "send", label: span("Status + send"), checked: false, disabled: false },
        { value: "gone", label: span("Removed option"), checked: false, disabled: true },
      ],
    },
    { kind: "text", name: "workers", type: "number", multiline: false, required: true, label: [], value: "", placeholder: "", min: 0, max: 8, rows: 1 },
    {
      kind: "choice", name: "channels", multi: true, select: false, other: true, required: false, label: span("Channels"),
      options: [
        { value: "ops", label: span("Ops"), checked: false, disabled: false },
        { value: "dev", label: span("Dev"), checked: false, disabled: false },
      ],
    },
    { kind: "text", name: "notes", type: "textarea", multiline: true, required: false, label: span("Notes"), value: "", placeholder: "", maxLength: 10, rows: 4 },
  ],
  hidden: [["revision", "rev-3"]],
};

const ask: MissionAsk = { id: "call-1", form };

test("status asks parse into the form the pane drew; malformed asks read as no ask", () => {
  const parsed = parseAsk(JSON.parse(JSON.stringify(ask)));
  expect(parsed).toEqual(ask);
  // The declared fields and the embedded field blocks stay the same objects the UI renders.
  const embedded = parsed!.form.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "field" ? [b.field] : []));
  for (const [i, f] of parsed!.form.fields.entries()) expect(f).toEqual(embedded[i]);
  for (const bad of [
    { id: "", form: ask.form },
    { id: "x" },
    { id: "x", form: {} },
    { id: "x", form: { ...form, fields: [] } },
    { id: "x", form: { ...form, fields: form.fields.slice(0, 3) } }, // a field block without its fields entry
    { id: "x", form: { ...form, hidden: [["revision", "rev-3"], ["revision", "rev-4"]] } }, // duplicate names
    { id: "x", form: { ...form, fields: [...form.fields, { kind: "text", name: "workers" }] } }, // duplicate field name
    { id: "x", form: { ...form, sections: [{ ...form.sections[0]!, blocks: [{ kind: "text", spans: "no" }] }] } },
  ])
    expect(parseAsk(bad)).toBeNull();
});

test("the card summary is the first field's question as the pane asks it", () => {
  expect(askSummary(ask)).toBe("Listen where?");
});

test("answers are per-name values: options, Other text, numbers — 0 included — and option lists", () => {
  const data = { revision: "rev-3", listen: "send", workers: 0, channels: ["ops", "dev"], notes: "ok" };
  expect(askAnswers(ask, data)).toEqual(data);
  // An optional field may be omitted entirely; a checkbox group's "Other" joins the list.
  expect(askAnswers(ask, { revision: "rev-3", listen: "something else", workers: "2", channels: ["ops", "extra"] }))
    .toEqual({ revision: "rev-3", listen: "something else", workers: "2", channels: ["ops", "extra"] });
  // Numeric text answers stay verbatim for the producer's own normalization.
  expect(askAnswers(ask, { revision: "rev-3", listen: "status", workers: "1e2", channels: [] }))
    .toEqual({ revision: "rev-3", listen: "status", workers: "1e2", channels: [] });
});

test("form hints are advisory while malformed wire answers are refused", () => {
  expect(askAnswers(ask, ["send"])).toBe("data must be a field-to-value object");
  expect(askAnswers(ask, { revision: "rev-3", listen: "send" })).toEqual({ revision: "rev-3", listen: "send" });
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 2, bogus: "x" })).toBe('"bogus" is not a field of this form');
  expect(askAnswers(ask, { revision: "rev-2", listen: "send", workers: 2 })).toBe('"revision" does not match the form\'s hidden value');
  expect(askAnswers(ask, { revision: "rev-3", listen: "gone", workers: 2 })).toBe("Listen where?: a disabled option");
  const fixedChoices = { ...ask, form: { ...form, fields: form.fields.map((f) => f.kind === "choice" ? { ...f, other: false } : f) } };
  expect(askAnswers(fixedChoices, { revision: "rev-3", listen: "nope", workers: 2 })).toBe("Listen where?: an unknown option");
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 2, channels: ["ops", "x", "y"] })).toBe("Channels: one free-text answer");
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 2, channels: "ops" })).toBe("Channels: an option list");
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 2, channels: [] })).toEqual({ revision: "rev-3", listen: "send", workers: 2, channels: [] });
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: "lots" })).toEqual({ revision: "rev-3", listen: "send", workers: "lots" });
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 9 })).toEqual({ revision: "rev-3", listen: "send", workers: 9 });
  expect(askAnswers(ask, { workers: Number.POSITIVE_INFINITY })).toEqual(expect.any(String));
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: true })).toEqual(expect.any(String));
  expect(askAnswers(ask, { revision: "rev-3", listen: "send", workers: 2, notes: "this is far too long" })).toEqual({ revision: "rev-3", listen: "send", workers: 2, notes: "this is far too long" });
});

test("a single checkbox answers with one value, not a list", () => {
  const single: MissionAsk = {
    id: "s",
    form: {
      sections: [{ title: [], fieldset: false, blocks: [{ kind: "field", field: { kind: "choice", name: "agree", multi: true, select: false, other: false, required: true, label: [], options: [{ value: "yes", label: span("I agree"), checked: false, disabled: false }] } }] }],
      fields: [{ kind: "choice", name: "agree", multi: true, select: false, other: false, required: true, label: [], options: [{ value: "yes", label: span("I agree"), checked: false, disabled: false }] }],
      hidden: [],
    },
  };
  expect(askAnswers(single, { agree: "yes" })).toEqual({ agree: "yes" });
  expect(askAnswers(single, { agree: ["yes"] })).toEqual(expect.any(String));
  expect(askAnswers(single, {})).toEqual({});
});
