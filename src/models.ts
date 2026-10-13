import type { ModelsResult, ModelEntry } from "./core/types.ts";
import type { CommandResult, Run } from "./ports.ts";

export interface ModelCatalogOptions {
  ttlMs?: number;
  timeoutMs?: number;
  cwd?: string;
  now?: () => number;
}

export interface ModelCatalog {
  getModels(): Promise<ModelsResult>;
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

  return {
    async getModels(): Promise<ModelsResult> {
      const current = now();
      if (cached && current - cached.timestamp < ttlMs) {
        return cached.result;
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = (async () => {
        try {
          const res = await fetchModels();
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
