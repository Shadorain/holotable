import { expect, test } from "bun:test";
import { subscriptionCapacity } from "../../src/core/subscription-capacity.ts";
import type { ModelEntry } from "../../src/core/types.ts";

const now = Date.parse("2026-10-14T22:00:00Z");
const model = (provider: string, id = "model"): ModelEntry => ({ provider, selector: `${provider}/${id}`, name: id });
function limit(provider: string, id: string, remaining: number, reset = now + 3_600_000, scope = {}) {
  return { id, label: id, scope: { provider, shared: true, ...scope }, window: { label: id, resetsAt: reset }, amount: { remainingFraction: remaining }, status: remaining === 0 ? "exhausted" : "ok" };
}
const report = (provider: string, limits: unknown[], extra = {}) => ({ provider, fetchedAt: now, limits, ...extra });

test("a depleted long window blocks a subscription even with short-window capacity", () => {
  const p = "anthropic";
  const result = subscriptionCapacity([model(p)], { reports: [report(p, [limit(p, "5h", 0.7), limit(p, "weekly", 0)])] }, now);
  expect(result.models[0]!.capacity).toMatchObject({ state: "exhausted", remainingFraction: 0 });
});

test("Grok product breakdowns do not exhaust unrelated models and paid overage is not subscription headroom", () => {
  const p = "xai-oauth";
  const limits = [limit(p, `${p}:credits:1w`, 0.6), limit(p, `${p}:product:grokbuild:1w`, 0)];
  expect(subscriptionCapacity([model(p, "grok")], { reports: [report(p, limits)] }, now).models[0]!.capacity?.state).toBe("available");
  limits[0] = limit(p, `${p}:credits:1w`, 0);
  limits.push(limit(p, `${p}:on-demand`, 0.9));
  expect(subscriptionCapacity([model(p, "grok")], { reports: [report(p, limits)] }, now).models[0]!.capacity?.state).toBe("exhausted");
});

test("Antigravity Gemini and the shared Claude/GPT counters do not consume each other's quota", () => {
  const p = "google-antigravity";
  const shared = { sharedGroup: "3p-weekly:weekly" };
  const limits = [limit(p, `${p}:google:gemini-weekly`, 0.99), limit(p, `${p}:anthropic:3p-weekly`, 0.006, undefined, shared), limit(p, `${p}:openai:3p-weekly`, 0.006, undefined, shared)];
  const result = subscriptionCapacity([model(p, "gemini-3.1-pro"), model(p, "claude-opus-5-5"), model(p, "gpt-oss-120b"), model(p, "unmapped")], { reports: [report(p, limits)] }, now);
  expect(result.models.map(m => m.capacity?.state)).toEqual(["available", "low", "low", "unknown"]);
  expect(result.models[1]!.capacity?.remainingFraction).toBe(0.006);
  expect(result.subscriptions.map(s => s.label)).toEqual(["Gemini", "Claude & GPT (shared)"]);
});

test("quota is the best account's limiting window, not a sum or the worst account", () => {
  const p = "anthropic";
  const result = subscriptionCapacity([model(p)], { reports: [report(p, [limit(p, "5h", 0)]), report(p, [limit(p, "5h", 0.7), limit(p, "7d", 0.4)])] }, now);
  expect(result.models[0]!.capacity).toMatchObject({ state: "available", remainingFraction: 0.4 });
});

test("unreported accounts prevent claiming every account is exhausted", () => {
  const p = "devin";
  const result = subscriptionCapacity([model(p)], { reports: [report(p, [limit(p, "weekly", 0)])], accountsWithoutUsage: [{ provider: p }] }, now);
  expect(result.models[0]!.capacity?.state).toBe("unknown");
});

test("stale and elapsed-reset snapshots are not treated as current capacity", () => {
  const p = "anthropic";
  for (const r of [report(p, [limit(p, "5h", 0.8)], { fetchedAt: now - 600_001 }), report(p, [limit(p, "5h", 0, now - 1000)], { fetchedAt: now - 2000 })]) {
    expect(subscriptionCapacity([model(p)], { reports: [r] }, now).models[0]!.capacity?.state).toBe("unknown");
  }
});

test("reset time waits for every exhausted window, not the first short-window reset", () => {
  const p = "anthropic";
  const result = subscriptionCapacity([model(p)], { reports: [report(p, [limit(p, "5h", 0, now + 3600000), limit(p, "7d", 0, now + 86400000)])] }, now);
  expect(result.models[0]!.capacity?.resetAt).toBe(now + 86400000);
});

test("model-scoped exhaustion and unknown tiers do not block unrelated models", () => {
  const p = "test";
  const result = subscriptionCapacity([model(p, "a"), model(p, "b")], { reports: [report(p, [limit(p, "a-only", 0, undefined, { modelId: "a" })])] }, now);
  expect(result.models.map(m => m.capacity?.state)).toEqual(["exhausted", "unknown"]);
  const tier = limit(p, "mystery", 0.9, undefined, { tier: "unknown", shared: false });
  expect(subscriptionCapacity([model(p)], { reports: [report(p, [tier])] }, now).models[0]!.capacity?.state).toBe("unknown");
});

test("near-limit boundary and unreported quota remain distinct from availability", () => {
  const p = "anthropic";
  for (const [remaining, state] of [[0.1, "low"], [0.10001, "available"], [0, "exhausted"]] as const) {
    expect(subscriptionCapacity([model(p)], { reports: [report(p, [limit(p, "5h", remaining)])] }, now).models[0]!.capacity?.state).toBe(state);
  }
  expect(subscriptionCapacity([model(p)], {}, now).models[0]!.capacity?.state).toBe("unknown");
});

test("subscription responses do not disclose provider account identities or raw credential metadata", () => {
  const p = "anthropic";
  const payload = { reports: [report(p, [limit(p, "5h", 0.5)], { metadata: { email: "private@example.com", token: "secret-token", endpoint: "private-endpoint" }, raw: { secret: "private-payload" } })] };
  const serialized = JSON.stringify(subscriptionCapacity([model(p)], payload, now));
  for (const secret of ["private@example.com", "secret-token", "private-endpoint", "private-payload"]) expect(serialized).not.toContain(secret);
});

test("account-wide policy diagnostics stay separate from model quota eligibility", () => {
  const provider = "google-antigravity";
  const reports = [
    report(provider, [limit(provider, `${provider}:google:gemini-weekly`, 0.4)], { policy: { state: "exhausted", account: "private-account" } }),
    report(provider, [limit(provider, `${provider}:anthropic:claude-weekly`, 0.6)], { policy: { state: "inside-reserve", endpoint: "private-endpoint" } }),
  ];
  const result = subscriptionCapacity([model(provider, "claude-opus")], { reports }, now);
  expect(result.models[0]!.capacity).toMatchObject({ state: "available", remainingFraction: 0.6 });
  expect(result.models[0]!.capacity!.detail).toContain("Routing policy (account-wide): 0 eligible, 1 inside reserve, 1 exhausted, 0 unknown; model routing remains OMP-owned");
  expect(result.subscriptions.find(item => item.label === "Claude")!.detail).toContain("1 inside reserve, 1 exhausted");
});

test("policy summaries count malformed, stale, reset, and unreported accounts as unknown", () => {
  const provider = "anthropic";
  const reports = [
    report(provider, [limit(provider, "5h", 0.7)], { policy: { state: "eligible" } }),
    report(provider, [limit(provider, "5h", 0.7)], { policy: { state: "eligible" }, fetchedAt: now - 600_001 }),
    report(provider, [limit(provider, "5h", 0.7, now - 1000)], { policy: { state: "exhausted" }, fetchedAt: now - 2000 }),
    report(provider, [limit(provider, "5h", 0.7)], { policy: { state: "arbitrary policy text" } }),
  ];
  const result = subscriptionCapacity([model(provider)], { reports, accountsWithoutUsage: [{ provider, account: "unreported-private" }] }, now);
  expect(result.subscriptions[0]!.detail).toContain("1 eligible, 0 inside reserve, 0 exhausted, 4 unknown");
  const serialized = JSON.stringify(result);
  for (const privateValue of ["private-account", "private-endpoint", "unreported-private", "arbitrary policy text"]) expect(serialized).not.toContain(privateValue);
});

test("absent or wholly unrecognized policy preserves legacy detail", () => {
  const provider = "anthropic";
  for (const payload of [
    { reports: [report(provider, [limit(provider, "5h", 0.5)])] },
    { reports: [report(provider, [limit(provider, "5h", 0.5)], { policy: { state: "not-a-state" } })] },
  ]) {
    expect(subscriptionCapacity([model(provider)], payload, now).models[0]!.capacity!.detail).toBe("Capacity on a reported account");
  }
});

test("a recognized policy on an account without usage enables the summary but counts unknown", () => {
  const provider = "anthropic";
  const result = subscriptionCapacity([model(provider)], {
    accountsWithoutUsage: [{ provider, policy: { state: "eligible" }, account: "private-missing-account" }],
  }, now);
  expect(result.subscriptions[0]!.detail).toContain("0 eligible, 0 inside reserve, 0 exhausted, 1 unknown");
  expect(JSON.stringify(result)).not.toContain("private-missing-account");
});
