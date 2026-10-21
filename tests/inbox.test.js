import { expect, test } from "bun:test";
import { errorLog } from "../web/inbox.js";

test("errors list newest first and count as unread until the inbox is opened", () => {
  const log = errorLog();
  log.add("land failed", 1000);
  log.add("launch failed", 2000);
  expect(log.entries.map((e) => e.text)).toEqual(["launch failed", "land failed"]);
  expect(log.unread).toBe(2);
  log.read();
  expect(log.unread).toBe(0);
  expect(log.entries).toHaveLength(2);
  log.add("relaunch failed", 3000);
  expect(log.unread).toBe(1);
});

test("clear empties the inbox and its unread count", () => {
  const log = errorLog();
  log.add("land failed", 1000);
  log.clear();
  expect(log.entries).toEqual([]);
  expect(log.unread).toBe(0);
});
