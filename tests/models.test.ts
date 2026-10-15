import { expect, test } from "bun:test";
import { createModelCatalog } from "../src/models.ts";
import type { CommandResult, Run } from "../src/ports.ts";

const now = Date.parse("2026-10-14T22:00:00Z");
const ok = (value: unknown): CommandResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const models = { models: [{ selector: "xai-oauth/grok", provider: "xai-oauth", name: "Grok" }] };
const usage = (remaining: number) => ({ reports: [{ provider: "xai-oauth", fetchedAt: now, limits: [{ id: "xai-oauth:credits:1w", scope: { provider: "xai-oauth", shared: true }, window: { label: "Weekly", resetsAt: now + 86400000 }, amount: { remainingFraction: remaining } }] }] });

test("quota failures leave the catalog searchable with explicitly unknown capacity", async () => {
  const run: Run = async (_command, args) => args[0] === "models" ? ok(models) : { code: 1, stdout: "", stderr: "private provider details" };
  const result = await createModelCatalog(run, { now: () => now }).getModels();
  expect(result.models.find(m => m.selector === "xai-oauth/grok")?.capacity?.state).toBe("unknown");
  expect(result.usageError).toBeDefined();
  expect(JSON.stringify(result)).not.toContain("private provider details");
});

test("explicit refresh replaces exhausted capacity and concurrent requests share the refreshed snapshot", async () => {
  let remaining = 0;
  let pending: Promise<CommandResult> | undefined;
  const run: Run = async (_command, args) => args[0] === "models" ? ok(models) : pending ?? ok(usage(remaining));
  const catalog = createModelCatalog(run, { now: () => now });
  expect((await catalog.getModels()).models[0]!.capacity?.state).toBe("exhausted");
  remaining = 0.6;
  expect((await catalog.getModels()).models[0]!.capacity?.state).toBe("exhausted");
  const held = Promise.withResolvers<CommandResult>();
  pending = held.promise;
  const refreshing = catalog.getModels(true);
  const concurrent = catalog.getModels();
  held.resolve(ok(usage(remaining)));
  const [fresh, joined] = await Promise.all([refreshing, concurrent]);
  expect(fresh.models[0]!.capacity).toMatchObject({ state: "available", remainingFraction: 0.6 });
  expect(joined).toBe(fresh);
});

test("expired catalog cache cannot keep suggesting a newly exhausted subscription", async () => {
  let clock = now;
  let remaining = 0.7;
  const run: Run = async (_command, args) => args[0] === "models" ? ok(models) : ok(usage(remaining));
  const catalog = createModelCatalog(run, { now: () => clock, ttlMs: 100 });
  expect((await catalog.getModels()).models[0]!.capacity?.state).toBe("available");
  remaining = 0;
  clock += 101;
  expect((await catalog.getModels()).models[0]!.capacity?.state).toBe("exhausted");
});

test("malformed usage cannot falsely imply usable capacity", async () => {
  const run: Run = async (_command, args) => args[0] === "models" ? ok(models) : ok({ reports: "invalid" });
  const result = await createModelCatalog(run, { now: () => now }).getModels();
  expect(result.usageError).toBeDefined();
  expect(result.models[0]!.capacity?.state).toBe("unknown");
});

test("usage deadline cannot hold model selection indefinitely", async () => {
  const held = Promise.withResolvers<CommandResult>();
  const run: Run = async (_command, args) => args[0] === "models" ? ok(models) : held.promise;
  const result = await createModelCatalog(run, { now: () => now, timeoutMs: 10 }).getModels();
  expect(result.usageError).toBeDefined();
  expect(result.models[0]!.capacity?.state).toBe("unknown");
  held.resolve(ok(usage(0)));
});
