import type { AskAnswer, MissionAsk } from "./types.ts";

export const MAX_ASK_TEXT = 4000;

/**
 * Parse an answer action's `answers` against the mission's open ask: one per question, an option index for
 * single-select, one or more indexes for multi-select, or free text ("Other"). The mission checks again when
 * it settles the dialog; this refuses a malformed click before anything is sent.
 */
export function askAnswers(ask: MissionAsk, raw: unknown): AskAnswer[] | string {
  if (!Array.isArray(raw)) return "answers must be a list";
  if (raw.length !== ask.questions.length) return `Answer all ${ask.questions.length} question${ask.questions.length === 1 ? "" : "s"}`;
  const answers: AskAnswer[] = [];
  for (const [index, question] of ask.questions.entries()) {
    const value = raw[index] as Record<string, unknown> | null;
    const inRange = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < question.options.length;
    if (typeof value !== "object" || value === null) return `Question ${index + 1} has no answer`;
    if (typeof value.text === "string") {
      const text = value.text.trim();
      if (!text) return `Question ${index + 1} needs an option or some text`;
      if (text.length > MAX_ASK_TEXT) return `Question ${index + 1}'s answer is over ${MAX_ASK_TEXT} characters`;
      answers.push({ text });
    } else if (question.multi) {
      if (!Array.isArray(value.options) || !value.options.length || !value.options.every(inRange))
        return `Question ${index + 1} needs one or more of its options`;
      answers.push({ options: value.options as number[] });
    } else {
      if (!inRange(value.option)) return `Question ${index + 1} has no option ${String(value.option)}`;
      answers.push({ option: value.option as number });
    }
  }
  return answers;
}
