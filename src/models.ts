import type { ModelsResult, ModelEntry } from "./core/types.ts";
import type { CommandResult, Run } from "./ports.ts";
import { subscriptionCapacity } from "./core/subscription-capacity.ts";

export interface ModelCatalogOptions {
  ttlMs?: number;
  timeoutMs?: number;
  cwd?: string;
  now?: () => number;
}

export interface ModelCatalog {
  getModels(refresh?: boolean): Promise<ModelsResult>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createModelCatalog(run: Run, options: ModelCatalogOptions = {}): ModelCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;

  let cached: { timestamp: number; result: ModelsResult } | null = null;
  let inFlight: Promise<ModelsResult> | null = null;

  async function fetchModels(): Promise<ModelsResult> {
    let timer: NodeJS.Timeout | undefined;
    let result: CommandResult;
    try {
      const { promise: timeout, reject } = Promise.withResolvers<CommandResult>();
      timer = setTimeout(() => reject(new Error("Catalog fetch timed out")), timeoutMs);
      timer.unref?.();
      result = await Promise.race([
        run("omp", ["models", "--json", "--no-extensions"], cwd),
        timeout,
      ]);
    } catch (error) {
      return {
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }

    if (result.code !== 0) {
      const err = result.stderr.trim() || result.stdout.trim() || `Command failed with code ${result.code}`;
      return { models: [], error: err };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      return {
        models: [],
        error: `Invalid JSON from models catalog: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { models: [], error: "Catalog response is not an object" };
    }

    const rawList = (parsed as Record<string, unknown>).models;
    if (!Array.isArray(rawList)) {
      return { models: [], error: "Catalog response missing models array" };
    }

    const models: ModelEntry[] = [];
    for (const item of rawList) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as Record<string, unknown>;
      const selector = typeof row.selector === "string" ? row.selector : null;
      if (!selector) continue;
      const name = typeof row.name === "string" ? row.name : selector;
      const provider = typeof row.provider === "string" ? row.provider : "";
      const entry: ModelEntry = { selector, name, provider };

      if (typeof row.reasoning === "boolean") {
        entry.reasoning = row.reasoning;
      }

      if (typeof row.cost === "object" && row.cost !== null) {
        const costObj = row.cost as Record<string, unknown>;
        if (typeof costObj.input === "number" && typeof costObj.output === "number") {
          entry.cost = { input: costObj.input, output: costObj.output };
        }
      }

      models.push(entry);
    }

    return { models };
  }

  async function fetchUsage(): Promise<{ payload?: unknown; error?: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<CommandResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Subscription usage timed out")), timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([run("omp", ["usage", "--json", "--redact", "--no-extensions"], cwd), timeout]);
      if (result.code !== 0) return { error: `OMP subscription usage unavailable (exit ${result.code})` };
      let payload: unknown;
      try { payload = JSON.parse(result.stdout); } catch { return { error: "Invalid subscription usage JSON" }; }
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).reports))
        return { error: "Subscription usage response is missing reports" };
      return { payload };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Subscription usage unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getModels(refresh = false): Promise<ModelsResult> {
      if (inFlight) return inFlight;
      const current = now();
      if (!refresh && cached && current - cached.timestamp < ttlMs) return cached.result;
      inFlight = (async () => {
        try {
          // CLI startups share the board's CPU budget; parallel reads can exhaust their deadlines.
          const models = await fetchModels();
          const usage = await fetchUsage();
          const res = { ...models, ...subscriptionCapacity(models.models, usage.payload, now()), ...(usage.error ? { usageError: usage.error } : {}) };
          cached = { timestamp: now(), result: res };
          return res;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
