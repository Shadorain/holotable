// Model catalog cache and searchable model dropdown component.
// Fetches GET /api/models on-demand via injected api port, caching in memory.
import { dropdown, el } from "./components.js";
import { fetchJson } from "./ui.js";

let catalogCache = null;
let catalogPromise = null;

/**
 * Fetches the model catalog on demand. Returns cached copy once fetched.
 * Catalog shape: { models: [{ selector, name, provider, cost?: { input, output }, reasoning?: boolean }], error?: string }
 */
export async function getModelCatalog(api) {
  if (catalogCache) return catalogCache;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    try {
      const res = await api("/api/models");
      const data = await fetchJson(res);
      if (!data.error) catalogCache = data;
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

export function buildModelOptions(catalog, {
  allowInherit = false,
  inheritLabel = "Inherit default",
  defaultModel = null,
  allowOmpDefault = true,
  currentValue = null,
} = {}) {
  const models = catalog?.models ?? [];
  const options = [];

  if (allowInherit) {
    const inheritedName = models.find((m) => m.selector === defaultModel)?.name;
    const inheritedDisplay = inheritedName ? `${inheritLabel} · ${inheritedName}` : inheritLabel;
    options.push({
      value: null,
      label: inheritedDisplay,
      hint: defaultModel ? `Uses ${defaultModel}` : "Inherits global or OMP default",
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
      label: `${m.name || m.selector} · ${m.provider || "Other"}`,
      meta: costHint,
      hint: hints.join(" · "),
    });
  }
  if (catalog?.error) options.push({ value: "__catalog_error__", label: `Catalog unavailable: ${catalog.error}`, disabled: true });

  // Preserve custom or currently selected model if not in catalog
  if (currentValue && !options.some((o) => o.value === currentValue)) {
    options.unshift({
      value: currentValue,
      label: currentValue,
      hint: `Custom model: ${currentValue}`,
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
  const initialOptions = buildModelOptions(catalogCache, {
    allowInherit,
    inheritLabel,
    defaultModel,
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
    onChange,
  });

  function loadCatalog() {
    if (!api) return;
    void getModelCatalog(api).then((cat) => {
      dd.setOptions(buildModelOptions(cat, {
        allowInherit,
        inheritLabel,
        defaultModel,
        allowOmpDefault,
        currentValue: dd.value,
      }), dd.value);
    });
  }

  return dd;
}
