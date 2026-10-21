import { expect, test } from "bun:test";
import { ensureNotes } from "../web/notes.js";

test("a failing notes endpoint is asked again only when the task counts move", async () => {
  let calls = 0;
  const api = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  };
  const loaded = () => new Promise((resolve) => ensureNotes("op-notes-fail", { done: 1, total: 2 }, api, resolve));
  await loaded();
  ensureNotes("op-notes-fail", { done: 1, total: 2 }, api, () => {});
  ensureNotes("op-notes-fail", { done: 1, total: 2 }, api, () => {});
  expect(calls).toBe(1);
  await new Promise((resolve) => ensureNotes("op-notes-fail", { done: 2, total: 2 }, api, resolve));
  expect(calls).toBe(2);
});
