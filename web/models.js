// Model catalog cache and searchable model dropdown component.
// Fetches GET /api/models on-demand via injected api port, caching in memory.
import { dropdown, el } from "./components.js";
import { fetchJson } from "./ui.js";

let catalogCache = null;
let catalogPromise = null;
let catalogAt = 0;

/**
 * Fetches the model catalog on demand. Returns cached copy once fetched.
 * Catalog shape: { models: [{ selector, name, provider, cost?: { input, output }, reasoning?: boolean }], error?: string }
 */
export async function getModelCatalog(api, { refresh = false } = {}) {
  if (catalogPromise) return catalogPromise;
  if (!refresh && catalogCache && Date.now() - catalogAt < 30_000) return catalogCache;
  catalogPromise = (async () => {
    try {
      const res = await api(refresh ? "/api/models?refresh=1" : "/api/models");
      const data = await fetchJson(res);
      catalogCache = data;
      catalogAt = Date.now();
      return data;
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      catalogPromise = null;
    }
  })();
  return catalogPromise;
}

const priceFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 });
/** Formats $/Mtok catalog pricing hint without claiming spend caps. */
export function formatCost(cost) {
  if (!cost) return "";
  const inp = cost.input !== undefined ? `$${priceFormat.format(cost.input)}` : "";
  const out = cost.output !== undefined ? `$${priceFormat.format(cost.output)}` : "";
  if (!inp && !out) return "";
  return `${inp}/${out}/Mtok`;
}

const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const capacityRank = { available: 0, low: 1, unknown: 2, exhausted: 3 };

export function capacityLabel(capacity) {
  if (!capacity || capacity.state === "unknown") return "Quota unknown";
  if (capacity.state === "exhausted") return "Exhausted";
  const left = capacity.remainingFraction === null ? "" : `${percent.format(capacity.remainingFraction)} left`;
  return capacity.state === "low" ? `Near limit · ${left}` : left;
}

function capacityHint(capacity) {
  if (!capacity) return "No subscription quota report";
  return [capacity.detail, capacity.resetAt ? `Resets ${dateTime.format(capacity.resetAt)}` : "",
    capacity.checkedAt ? `Reported ${dateTime.format(capacity.checkedAt)}` : ""].filter(Boolean).join(" · ");
}

export function subscriptionPanel(api, onCatalog) {
  const root = el("div", "subscription-panel");
  const tools = el("div", "subscription-tools");
  const load = el("button", "", "Load subscription quotas");
  load.type = "button";
  const result = el("div", "subscription-results");
  result.setAttribute("aria-live", "polite");
  tools.append(load);
  root.append(tools, result);
  load.addEventListener("click", async () => {
    load.disabled = true;
    result.textContent = "Checking OMP subscription quotas…";
    try {
      const catalog = await getModelCatalog(api, { refresh: true });
      onCatalog?.(catalog);
      result.replaceChildren();
      if (catalog.usageError) result.append(el("p", "set-warn", catalog.usageError));
      if (!catalog.subscriptions?.length) result.append(el("p", "set-note", "No subscription quota reports available. Unknown quota is not evidence of remaining capacity."));
      for (const subscription of catalog.subscriptions ?? []) {
        const card = el("div", `subscription-capacity capacity-${subscription.state}`);
        card.append(el("strong", "", subscription.label === subscription.provider ? subscription.provider : `${subscription.provider} · ${subscription.label}`));
        card.append(el("div", "subscription-state", capacityLabel(subscription)));
        card.append(el("div", "set-note", capacityHint(subscription)));
        for (const window of subscription.windows) {
          card.append(el("div", "subscription-window", [
            window.label,
            window.remainingFraction === null ? "Quota unknown" : `${percent.format(window.remainingFraction)} left`,
            window.resetAt ? `resets ${dateTime.format(window.resetAt)}` : "",
          ].filter(Boolean).join(" · ")));
        }
        result.append(card);
      }
    } catch (error) {
      result.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      load.textContent = "Refresh subscription quotas";
      load.disabled = false;
    }
  });
  return root;
}

export function buildModelOptions(catalog, {
  allowInherit = false,
  inheritLabel = "Inherit default",
  defaultModel = null,
  allowOmpDefault = true,
  currentValue = null,
} = {}) {
  const models = [...(catalog?.models ?? [])].sort((a, b) =>
    (capacityRank[a.capacity?.state ?? "unknown"] - capacityRank[b.capacity?.state ?? "unknown"]) ||
    ((b.capacity?.remainingFraction ?? -1) - (a.capacity?.remainingFraction ?? -1)) ||
    a.name.localeCompare(b.name));
  const options = [];
  const knownModel = (selector) => models.find(m => m.selector === String(selector ?? "").replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/, ""));

  if (allowInherit) {
    const inherited = knownModel(defaultModel);
    const inheritedDisplay = inherited ? `${inheritLabel} · ${inherited.name} · ${capacityLabel(inherited.capacity)}` : inheritLabel;
    options.push({
      value: null,
      label: inheritedDisplay,
      hint: defaultModel ? `Uses ${defaultModel} · ${capacityHint(inherited?.capacity)}` : "Inherits global or OMP default; quota depends on OMP routing",
      disabled: inherited?.capacity?.state === "exhausted",
    });
  }

  if (allowOmpDefault) {
    options.push({
      value: "",
      label: "OMP default",
      hint: "OMP CLI default (--model flag omitted)",
    });
  }

  for (const m of models) {
    const costHint = formatCost(m.cost);
    const hints = [m.selector];
    if (m.reasoning) hints.push("reasoning");
    if (costHint) hints.push(costHint);
    options.push({
      value: m.selector,
      label: `${m.name || m.selector} · ${m.provider || "Other"} · ${capacityLabel(m.capacity)}`,
      meta: m.capacity?.state === "available" ? "Reported capacity" : m.capacity?.state === "low" ? "Near limit" : "",
      hint: [...hints, capacityHint(m.capacity)].join(" · "),
      disabled: m.capacity?.state === "exhausted",
    });
  }
  if (catalog?.error) options.push({ value: "__catalog_error__", label: `Catalog unavailable: ${catalog.error}`, disabled: true });

  // Preserve custom or currently selected model if not in catalog
  if (currentValue && !options.some((o) => o.value === currentValue)) {
    const known = knownModel(currentValue);
    options.unshift({
      value: currentValue,
      label: known ? `${currentValue} · ${capacityLabel(known.capacity)}` : currentValue,
      hint: known ? capacityHint(known.capacity) : `Custom model: ${currentValue} · subscription quota unknown`,
      disabled: known?.capacity?.state === "exhausted",
    });
  }

  return options;
}

/**
 * Creates a searchable model dropdown.
 * Returns the dropdown component with .root, .value, .setValue(v), .setDisabled(b), etc.
 */
export function modelDropdown({
  api,
  value = null,
  onChange,
  label = "Model",
  placeholder = "Model",
  allowInherit = false,
  inheritLabel = "Inherit default",
  defaultModel = null,
  allowOmpDefault = true,
  className = "",
} = {}) {
  const selectedDefault = () => typeof defaultModel === "function" ? defaultModel() : defaultModel;
  const initialOptions = buildModelOptions(catalogCache, {
    allowInherit,
    inheritLabel,
    defaultModel: selectedDefault(),
    allowOmpDefault,
    currentValue: value,
  });

  const dd = dropdown({
    className: `model-dropdown${className ? ` ${className}` : ""}`,
    label,
    placeholder,
    options: initialOptions,
    value: value ?? (allowInherit ? null : ""),
    searchable: true,
    searchPlaceholder: "Search models…",
    maxOptions: 60,
    onOpen: loadCatalog,
    footers: [{ label: "Refresh subscription quotas", onPick: () => loadCatalog(true) }],
    onChange,
  });

  function setCatalog(cat) {
    dd.setOptions(buildModelOptions(cat, {
      allowInherit,
      inheritLabel,
      defaultModel: selectedDefault(),
      allowOmpDefault,
      currentValue: dd.value,
    }), dd.value);
  }

  function loadCatalog(refresh = false) {
    if (api) void getModelCatalog(api, { refresh }).then(setCatalog);
  }
  dd.setCatalog = setCatalog;

  return dd;
}
