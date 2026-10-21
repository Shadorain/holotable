import { expect, test } from "bun:test";
import { askAnswers } from "../../src/core/ask.ts";

const ask = {
  id: "c",
  questions: [
    { question: "One?", options: ["a", "b"], recommended: 0, multi: false },
    { question: "Many?", options: ["x", "y", "z"], recommended: null, multi: true },
  ],
};

test("answers are an option per single-select question, options per multi-select, or trimmed free text", () => {
  expect(askAnswers(ask, [{ option: 1 }, { options: [2, 0] }])).toEqual([{ option: 1 }, { options: [2, 0] }]);
  expect(askAnswers(ask, [{ text: "  neither  " }, { text: "all" }])).toEqual([{ text: "neither" }, { text: "all" }]);
});

test("answers the dialog cannot take are refused before anything is sent", () => {
  expect(askAnswers(ask, [{ option: 0 }])).toBe("Answer all 2 questions");
  expect(askAnswers(ask, [{ option: 2 }, { options: [0] }])).toBe("Question 1 has no option 2");
  expect(askAnswers(ask, [{ options: [0] }, { options: [0] }])).toBe("Question 1 has no option undefined");
  expect(askAnswers(ask, [{ option: 0 }, { options: [] }])).toBe("Question 2 needs one or more of its options");
  expect(askAnswers(ask, [{ text: " " }, { options: [0] }])).toBe("Question 1 needs an option or some text");
});
