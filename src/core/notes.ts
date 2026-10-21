const TASK_LINE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** Markdown task lines (`- [ ]`, `* [x]`, case-insensitive x) outside fenced code blocks, in order. */
export function taskLines(text: string | null): Array<{ done: boolean; text: string }> {
  if (text === null) return [];
  const tasks: Array<{ done: boolean; text: string }> = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = TASK_LINE.exec(line);
    if (m !== null) tasks.push({ done: m[1]!.toLowerCase() === "x", text: m[2]!.trim() });
  }
  return tasks;
}

/** `{done:0,total:0}` for absent text and text with no task lines. */
export function countTasks(text: string | null): { done: number; total: number } {
  const tasks = taskLines(text);
  return { done: tasks.filter((t) => t.done).length, total: tasks.length };
}

/** One `- [ ]`/`- [x]` line per workflow item; `done` holds the latest workflow event per item. */
export function workflowToMarkdown(
  items: Array<{ id: string; label: string }>,
  done: Record<string, boolean>,
): string {
  return items.map((item) => `- [${done[item.id] ? "x" : " "}] ${item.label}`).join("\n");
}
