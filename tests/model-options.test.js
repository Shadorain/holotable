import { expect, test } from "bun:test";
import { buildModelOptions, capacityLabel } from "../web/models.js";

const model = (selector, state, remainingFraction = null) => ({ selector, provider: selector.split("/")[0], name: selector, capacity: { state, remainingFraction, checkedAt: 1792029000000, resetAt: 1792040000000, detail: state } });
const catalog = { models: [model("xai-oauth/grok", "exhausted", 0), model("devin/swe-2", "unknown"), model("anthropic/claude", "low", 0.006), model("google-antigravity/gemini", "available", 0.99)] };

test("exhausted Grok is unselectable while reported usable models lead the choices", () => {
  const options = buildModelOptions(catalog, { allowOmpDefault: false });
  expect(options.find(option => option.value === "xai-oauth/grok").disabled).toBe(true);
  expect(options[0].value).toBe("google-antigravity/gemini");
  expect(options.findIndex(option => option.value === "anthropic/claude")).toBeLessThan(options.findIndex(option => option.value === "devin/swe-2"));
});

test("current exhausted selection remains visible and cannot be silently relabeled healthy", () => {
  const options = buildModelOptions(catalog, { currentValue: "xai-oauth/grok" });
  const current = options.find(option => option.value === "xai-oauth/grok");
  expect(current.label).toContain("Exhausted");
  expect(current.disabled).toBe(true);
});

test("inheriting a known exhausted default warns and does not offer a disguised usable choice", () => {
  const options = buildModelOptions(catalog, { allowInherit: true, defaultModel: "xai-oauth/grok", currentValue: null });
  const inherited = options.find(option => option.value === null);
  expect(inherited.label).toContain("Exhausted");
  expect(inherited.disabled).toBe(true);
});

test("tiny remaining capacity warns without rounding it to a misleading zero or hiding unknowns", () => {
  expect(capacityLabel(model("a/b", "low", 0.006).capacity)).toContain("0.6%");
  expect(capacityLabel(model("a/b", "low", 0.006).capacity)).toContain("Near limit");
  expect(capacityLabel(model("a/b", "unknown").capacity)).toBe("Quota unknown");
});
