const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Markdown task lines (`- [ ]`, `* [x]`, case-insensitive x) outside fenced
 * code blocks. `{done:0,total:0}` for absent text and text with no task lines.
 */
export function countTasks(text: string | null): { done: number; total: number } {
  if (text === null) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TASK_LINE.exec(line);
    if (m === null) continue;
    total += 1;
    if (m[1]!.toLowerCase() === "x") done += 1;
  }
  return { done, total };
}

/** One `- [ ]`/`- [x]` line per workflow item; `done` holds the latest workflow event per item. */
export function workflowToMarkdown(
  items: Array<{ id: string; label: string }>,
  done: Record<string, boolean>,
): string {
  return items.map((item) => `- [${done[item.id] ? "x" : " "}] ${item.label}`).join("\n");
}
