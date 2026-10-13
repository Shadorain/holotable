import { describe, expect, test } from "bun:test";
import { createModelCatalog } from "../src/models.ts";
import type { CommandResult, Run } from "../src/ports.ts";

describe("createModelCatalog", () => {
  test("single-flight concurrency: concurrent callers share one in-flight run execution", async () => {
    let callCount = 0;
    const { promise: runHold, resolve: finishRun } = Promise.withResolvers<CommandResult>();

    const run: Run = async () => {
      callCount++;
      return runHold;
    };

    const catalog = createModelCatalog(run);
    const p1 = catalog.getModels();
    const p2 = catalog.getModels();
    const p3 = catalog.getModels();

    finishRun({
      code: 0,
      stdout: JSON.stringify({
        models: [
          {
            selector: "anthropic/claude-3-5-sonnet",
            name: "Claude Sonnet 3.5",
            provider: "anthropic",
            cost: { input: 3, output: 15 },
            reasoning: false,
          },
        ],
      }),
      stderr: "",
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(callCount).toBe(1);
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  test("cache TTL expires and re-fetches using deterministic clock", async () => {
    let callCount = 0;
    let clock = 1000;
    const run: Run = async () => {
      callCount++;
      return {
        code: 0,
        stdout: JSON.stringify({
          models: [
            {
              selector: `model-v${callCount}`,
              name: `Model ${callCount}`,
              provider: "test",
            },
          ],
        }),
        stderr: "",
      };
    };

    const catalog = createModelCatalog(run, { ttlMs: 50, now: () => clock });
    const res1 = await catalog.getModels();
    expect(res1.models[0].selector).toBe("model-v1");
    expect(callCount).toBe(1);

    const res2 = await catalog.getModels();
    expect(res2.models[0].selector).toBe("model-v1");
    expect(callCount).toBe(1);

    clock += 60;

    const res3 = await catalog.getModels();
    expect(res3.models[0].selector).toBe("model-v2");
    expect(callCount).toBe(2);
  });

  test("returns error on non-zero exit code", async () => {
    const run: Run = async () => ({
      code: 1,
      stdout: "",
      stderr: "omp: failed to connect to daemon",
    });

    const catalog = createModelCatalog(run);
    const result = await catalog.getModels();
    expect(result.models).toEqual([]);
    expect(result.error).toBeTypeOf("string");
  });

  test("returns error on command timeout", async () => {
    // Deliberately exercises bounded catalog timeout race against platform clock
    const { promise: pending } = Promise.withResolvers<CommandResult>();
    const run: Run = async () => pending;

    const catalog = createModelCatalog(run, { timeoutMs: 10 });
    const result = await catalog.getModels();
    expect(result.models).toEqual([]);
    expect(result.error).toBeTypeOf("string");
  });

  test("returns error on malformed JSON", async () => {
    const run: Run = async () => ({
      code: 0,
      stdout: "not-json",
      stderr: "",
    });

    const catalog = createModelCatalog(run);
    const result = await catalog.getModels();
    expect(result.models).toEqual([]);
    expect(result.error).toBeTypeOf("string");
  });

  test("returns error when payload missing models array", async () => {
    const run: Run = async () => ({
      code: 0,
      stdout: JSON.stringify({ foo: "bar" }),
      stderr: "",
    });

    const catalog = createModelCatalog(run);
    const result = await catalog.getModels();
    expect(result.models).toEqual([]);
    expect(result.error).toBeTypeOf("string");
  });

  test("parses valid models, maps costs and reasoning, and skips rows missing selector", async () => {
    const run: Run = async () => ({
      code: 0,
      stdout: JSON.stringify({
        models: [
          {
            selector: "provider-a/model-1",
            name: "Model One",
            provider: "provider-a",
            cost: { input: 2.5, output: 10, cacheRead: 0.25 },
            reasoning: true,
          },
          {
            id: "model-without-selector",
            name: "Model Two",
            provider: "provider-b",
          },
          {
            // invalid row: missing selector and id
            name: "Invalid Model",
          },
          "not an object",
        ],
      }),
      stderr: "",
    });

    const catalog = createModelCatalog(run);
    const result = await catalog.getModels();
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual([
      {
        selector: "provider-a/model-1",
        name: "Model One",
        provider: "provider-a",
        cost: { input: 2.5, output: 10 },
        reasoning: true,
      },
    ]);
  });
});
