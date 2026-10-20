import { expect, test } from "bun:test";
import { askKeys } from "../../src/core/ask.ts";

const UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r";
const q = (options: string[], recommended: number | null = 0, multi = false) => ({ question: "Q?", options, recommended, multi });

test("an option is reached from the top row whatever the cursor; one question submits on its Enter", () => {
  expect(askKeys({ id: "c", questions: [q(["a", "b", "c"], 2)] }, [{ option: 0 }])).toEqual([UP.repeat(4), ENTER]);
  expect(askKeys({ id: "c", questions: [q(["a", "b", "c"])] }, [{ option: 2 }])).toEqual([UP.repeat(4) + DOWN.repeat(2), ENTER]);
});

test("free text goes through Other as one line; several questions end on the Review tab's Enter", () => {
  const keys = askKeys({ id: "c", questions: [q(["a", "b"]), q(["x"])] }, [{ text: " use\nthe   outbox " }, { option: 0 }]);
  expect(keys).toEqual([UP.repeat(3) + DOWN.repeat(2), ENTER, "use the outbox", ENTER, UP.repeat(2), ENTER, ENTER]);
});

test("answers the dialog cannot take are refused before anything is typed", () => {
  expect(() => askKeys({ id: "c", questions: [q(["a"])] }, [])).toThrow(/Answer all 1 question/);
  expect(() => askKeys({ id: "c", questions: [q(["a"])] }, [{ option: 1 }])).toThrow(/no option 1/);
  expect(() => askKeys({ id: "c", questions: [q(["a"])] }, [{ text: "  " }])).toThrow(/needs an option or some text/);
  expect(() => askKeys({ id: "c", questions: [q(["a", "b"], 0, true)] }, [{ option: 0 }])).toThrow(/Multi-select/);
});
