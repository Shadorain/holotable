import type { AskAnswer, MissionAsk } from "./types.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
export const MAX_ASK_TEXT = 4000;

/**
 * The input that answers a mission's open `ask` in its OMP pane, one chunk per dialog step.
 * Each question lists its options then "Other". The dialog clamps Up at the top row and never wraps,
 * so a run of Up first puts the cursor on row 0 wherever the operator left it.
 * Enter on an option answers it. On "Other" it opens an editor that takes the text and its own Enter.
 * One question submits on its answer. Several advance tab by tab from the first, and the Review tab's Enter submits.
 * Throws a readable Error for answers the dialog cannot take.
 */
export function askKeys(ask: MissionAsk, answers: readonly AskAnswer[]): string[] {
  const count = ask.questions.length;
  if (answers.length !== count) throw new Error(`Answer all ${count} question${count === 1 ? "" : "s"}`);
  const chunks: string[] = [];
  ask.questions.forEach((question, index) => {
    if (question.multi) throw new Error("Multi-select questions are answered in the mission pane");
    const answer = answers[index]!;
    const rows = question.options.length + 1;
    if ("option" in answer) {
      if (!Number.isSafeInteger(answer.option) || answer.option < 0 || answer.option >= question.options.length)
        throw new Error(`Question ${index + 1} has no option ${answer.option}`);
      chunks.push(UP.repeat(rows) + DOWN.repeat(answer.option), ENTER);
      return;
    }
    // A newline in the editor would submit early, so the text goes in as one line.
    const text = answer.text.replace(/\s+/g, " ").trim();
    if (!text) throw new Error(`Question ${index + 1} needs an option or some text`);
    if (text.length > MAX_ASK_TEXT) throw new Error(`Question ${index + 1}'s answer is over ${MAX_ASK_TEXT} characters`);
    chunks.push(UP.repeat(rows) + DOWN.repeat(question.options.length), ENTER, text, ENTER);
  });
  if (count > 1) chunks.push(ENTER);
  return chunks;
}

/** Parse the `answers` argument of an answer action; null when it is not an array of {option} / {text}. */
export function parseAskAnswers(raw: unknown): AskAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const answers: AskAnswer[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.option === "number" && v.text === undefined) answers.push({ option: v.option });
    else if (typeof v.text === "string" && v.option === undefined) answers.push({ text: v.text });
    else return null;
  }
  return answers;
}
