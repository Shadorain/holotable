import type { ModelCapacity, ModelEntry, SubscriptionCapacity } from "./types.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n >= 0 && n <= 8_640_000_000_000_000 ? n : null;
};
const MAX_AGE_MS = 10 * 60_000;
const unknown = (detail = "No reliable subscription quota reported"): ModelCapacity => ({ state: "unknown", remainingFraction: null, resetAt: null, checkedAt: null, detail });

function remaining(limit: Row): number | null {
  const amount = row(limit.amount);
  const fraction = finite(amount.remainingFraction);
  if (fraction !== null) return fraction >= 0 && fraction <= 1 ? fraction : null;
  const used = finite(amount.usedFraction);
  if (used !== null) return used >= 0 ? Math.max(0, 1 - used) : null;
  const max = finite(amount.limit), left = finite(amount.remaining), spent = finite(amount.used);
  if (max !== null && max > 0) {
    if (left !== null) return Math.max(0, Math.min(1, left / max));
    if (spent !== null && spent >= 0) return Math.max(0, 1 - spent / max);
  }
  if (amount.unit === "percent" && spent !== null && spent >= 0) return Math.max(0, 1 - spent / 100);
  return null;
}

// OMP's Antigravity quota counters are backend-family scoped, not provider-wide.
function counterFor(model: string): string | null {
  if (model.includes("claude-")) return "anthropic";
  if (["gemini-", "gemma-", "tab_"].some(part => model.includes(part))) return "google";
  if (["gpt-", "openai/"].some(part => model.includes(part))) return "openai";
  return null;
}

function limitsFor(report: Row, provider: string, model?: string, counter?: string): Row[] {
  const limits = Array.isArray(report.limits) ? report.limits.map(row) : [];
  let scoped = limits.filter(limit => {
    const scope = row(limit.scope);
    if (scope.provider !== provider) return false;
    if (scope.modelId !== undefined) return model !== undefined && scope.modelId === model;
    // Devin's tier is an account plan, not a model tier. Unknown model tiers cannot be extrapolated.
    return scope.tier === undefined || scope.shared === true || provider === "devin";
  });
  if (provider === "xai-oauth") {
    if (row(report.metadata).monthlyQuotaAdvisory === true) return [];
    // Product breakdowns and paid overage are not additional subscription windows.
    scoped = scoped.filter(limit => limit.id === "xai-oauth:credits:1w" || limit.id === "xai-oauth:included:1mo");
  }
  if (provider === "google-antigravity") {
    const family = counter ?? (model ? counterFor(model) : null);
    if (!family) return [];
    const matching = scoped.filter(limit => String(limit.id).startsWith(`${provider}:${family}:`));
    scoped = matching.length ? matching : scoped.filter(limit => String(limit.id).startsWith(`${provider}:default:`));
  }
  return scoped;
}

type AccountCapacity = ModelCapacity & { windows: SubscriptionCapacity["windows"] };
function accountCapacity(report: Row, limits: Row[], now: number): AccountCapacity {
  const checkedAt = timestamp(report.fetchedAt);
  const windows = limits.map(limit => ({
    label: typeof row(limit.window).label === "string" ? row(limit.window).label as string : String(limit.label ?? "Quota"),
    remainingFraction: remaining(limit), resetAt: timestamp(row(limit.window).resetsAt),
  }));
  const stale = checkedAt === null || checkedAt > now + 60_000 || now - checkedAt > MAX_AGE_MS || windows.some(window => window.resetAt !== null && window.resetAt <= now && checkedAt < window.resetAt);
  if (stale || !limits.length) return { ...unknown(stale ? "Quota snapshot is stale; refresh before choosing" : undefined), checkedAt, windows };
  const exhausted = limits.map((limit, i) => ({ limit, window: windows[i]! })).filter(({ limit, window }) => limit.status === "exhausted" || window.remainingFraction === 0);
  if (exhausted.length) {
    const resets = exhausted.map(({ window }) => window.resetAt);
    return { state: "exhausted", remainingFraction: 0, resetAt: resets.every(value => value !== null) ? Math.max(...resets as number[]) : null, checkedAt, detail: "Reported subscription exhausted", windows };
  }
  if (windows.some(window => window.remainingFraction === null) || limits.some(limit => limit.status === "unknown"))
    return { ...unknown(), checkedAt, windows };
  const limiting = windows.reduce((a, b) => a.remainingFraction! <= b.remainingFraction! ? a : b);
  const low = limiting.remainingFraction! <= 0.1 + 1e-9 || limits.some(limit => limit.status === "warning");
  return { state: low ? "low" : "available", remainingFraction: limiting.remainingFraction, resetAt: limiting.resetAt, checkedAt, detail: low ? "Near subscription limit" : "Capacity on a reported account", windows };
}

function bestCapacity(reports: Row[], provider: string, now: number, missing: boolean, model?: string, counter?: string): AccountCapacity {
  const accounts = reports.map(report => accountCapacity(report, limitsFor(report, provider, model, counter), now));
  const usable = accounts.filter(account => account.state === "available" || account.state === "low").sort((a, b) => (b.remainingFraction ?? 0) - (a.remainingFraction ?? 0));
  if (usable.length) return usable[0]!;
  if (missing || accounts.some(account => account.state === "unknown") || !accounts.length) {
    const latest = accounts.reduce<number | null>((at, account) => account.checkedAt !== null ? Math.max(at ?? 0, account.checkedAt) : at, null);
    return { ...unknown(missing ? "Some authenticated accounts have no quota report" : accounts.find(account => account.state === "unknown")?.detail), checkedAt: latest, windows: accounts[0]?.windows ?? [] };
  }
  const chosen = accounts.reduce((a, b) => (a.resetAt ?? Infinity) <= (b.resetAt ?? Infinity) ? a : b);
  return chosen;
}

export function subscriptionCapacity(models: ModelEntry[], payload: unknown, now: number): { models: ModelEntry[]; subscriptions: SubscriptionCapacity[] } {
  const input = row(payload);
  const reports = Array.isArray(input.reports) ? input.reports.map(row).filter(report => typeof report.provider === "string") : [];
  const withoutUsage = Array.isArray(input.accountsWithoutUsage) ? input.accountsWithoutUsage.map(row) : [];
  const providers = [...new Set([...reports, ...withoutUsage].map(report => report.provider).filter((provider): provider is string => typeof provider === "string"))];
  const byProvider = new Map(providers.map(provider => [provider, reports.filter(report => report.provider === provider)]));
  const missing = new Set(withoutUsage.map(report => report.provider));
  const projected = models.map(model => {
    const id = model.selector.slice(model.provider.length + 1);
    const { windows: _windows, ...capacity } = bestCapacity(byProvider.get(model.provider) ?? [], model.provider, now, missing.has(model.provider), id);
    return { ...model, capacity };
  });
  const subscriptions: SubscriptionCapacity[] = [];
  for (const provider of providers) {
    const providerReports = byProvider.get(provider) ?? [];
    if (provider === "google-antigravity") {
      const shared = providerReports.some(report => Array.isArray(report.limits) && report.limits.some(value => String(row(row(value).scope).sharedGroup ?? "").startsWith("3p-")));
      const families = shared ? [["google", "Gemini"], ["anthropic", "Claude & GPT (shared)"]] : [["google", "Gemini"], ["anthropic", "Claude"], ["openai", "GPT"]];
      for (const [counter, label] of families) {
        if (!providerReports.some(report => limitsFor(report, provider, undefined, counter).length)) continue;
        subscriptions.push({ provider, label: label!, ...bestCapacity(providerReports, provider, now, missing.has(provider), undefined, counter) });
      }
    } else {
      subscriptions.push({ provider, label: provider, ...bestCapacity(providerReports, provider, now, missing.has(provider)) });
    }
  }
  return { models: projected, subscriptions };
}
