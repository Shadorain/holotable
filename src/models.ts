import type { ModelsResult, ModelEntry } from "./core/types.ts";
import type { CommandResult, Run } from "./ports.ts";
import { subscriptionCapacity } from "./core/subscription-capacity.ts";
import { messageOf } from "./core/errors.ts";
import { withTimeout } from "./timeout.ts";

export interface ModelCatalogOptions {
  ttlMs?: number;
  timeoutMs?: number;
  cwd?: string;
  now?: () => number;
}

export interface ModelCatalog {
  getModels(refresh?: boolean, includeUsage?: boolean): Promise<ModelsResult>;
}

const DEFAULT_TTL_MS = 30_000;
// `omp models` costs about a CPU-second at startup; under the board's CPUQuota=25% that is 5 s alone, more under load.
const DEFAULT_TIMEOUT_MS = 30_000;

export function createModelCatalog(run: Run, options: ModelCatalogOptions = {}): ModelCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;

  let cached: { timestamp: number; result: ModelsResult } | null = null;
  let inFlight: Promise<ModelsResult> | null = null;
  let catalog: { timestamp: number; result: ModelsResult } | null = null;
  let catalogFlight: Promise<ModelsResult> | null = null;
  let lastUsage: { timestamp: number; payload?: unknown; error?: string } | null = null;

  function getCatalog(refresh: boolean): Promise<ModelsResult> {
    const good = catalog !== null && !catalog.result.error ? catalog : null;
    if (!refresh && good && now() - good.timestamp < ttlMs) return Promise.resolve(good.result);
    catalogFlight ??= fetchModels().then(result => {
      // A failed refresh keeps the last good list: what a provider offers rarely changes between pickers.
      if (!result.error || catalog === null || catalog.result.error) {
        catalog = { timestamp: now(), result };
        cached = null;
      }
      return catalog.result;
    }).finally(() => { catalogFlight = null; });
    // Stale-while-revalidate: the last good list answers now; the refresh serves the next picker.
    return good ? Promise.resolve(good.result) : catalogFlight;
  }

  async function fetchModels(): Promise<ModelsResult> {
    let result: CommandResult;
    try {
      result = await withTimeout(run("omp", ["models", "--json", "--no-extensions"], cwd), timeoutMs, "Catalog fetch timed out");
    } catch (error) {
      return {
        models: [],
        error: messageOf(error),
      };
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
        error: `Invalid JSON from models catalog: ${messageOf(error)}`,
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
    try {
      const result = await withTimeout(run("omp", ["usage", "--json", "--redact", "--no-extensions"], cwd), timeoutMs, "Subscription usage timed out");
      if (result.code !== 0) return { error: `OMP subscription usage unavailable (exit ${result.code})` };
      let payload: unknown;
      try { payload = JSON.parse(result.stdout); } catch { return { error: "Invalid subscription usage JSON" }; }
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).reports))
        return { error: "Subscription usage response is missing reports" };
      return { payload };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Subscription usage unavailable" };
    }
  }

  return {
    async getModels(refresh = false, includeUsage = false): Promise<ModelsResult> {
      if (!includeUsage) {
        if (!refresh && cached && now() - cached.timestamp < ttlMs) return cached.result;
        const models = await getCatalog(refresh);
        const usage = lastUsage && now() - lastUsage.timestamp < ttlMs ? lastUsage : undefined;
        return { ...models, ...subscriptionCapacity(models.models, usage?.payload, now()), ...(usage?.error ? { usageError: usage.error } : {}) };
      }
      if (inFlight) return inFlight;
      const current = now();
      if (!refresh && cached && current - cached.timestamp < ttlMs) return cached.result;
      inFlight = (async () => {
        try {
          const models = await getCatalog(false);
          const usage = await fetchUsage();
          lastUsage = { timestamp: now(), ...usage };
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
