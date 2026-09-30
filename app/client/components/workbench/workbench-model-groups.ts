/*
 * Exports:
 * - groupWorkbenchModels: favourite, recent and provider sections with optional drag order.
 * - WorkbenchModelGroup/WorkbenchGroupedModel: section and model identities for both pickers.
 */
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";

export interface WorkbenchGroupedModel {
  harness: WorkbenchHarness;
  model: WorkbenchModelOption;
}

export interface WorkbenchModelGroup {
  id: string;
  kind: "favourites" | "recent" | "provider";
  label: string;
  models: WorkbenchGroupedModel[];
  harness?: WorkbenchHarness;
  providerId?: string;
}

const HARNESS_ORDER = ["claude", "codex", "opencode"] as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function modelKey(harness: WorkbenchHarness, modelId: string) {
  return `${harness}\0${modelId}`;
}

function openCodeProviderId(modelId: string) {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "opencode";
}

function openCodeLabel(providerId: string) {
  if (providerId === "opencode-go") return "OpenCode Go";
  if (providerId === "opencode-zen") return "OpenCode Zen";
  return providerId === "opencode" ? "OpenCode" : `OpenCode / ${providerId}`;
}

export function groupWorkbenchModels({
  catalogues, favourites, allowedHarnesses, now, order = "editor",
}: {
  catalogues: Partial<Record<WorkbenchHarness, readonly WorkbenchModelOption[]>>;
  favourites: readonly { harness: WorkbenchHarness; modelId: string }[];
  allowedHarnesses: readonly WorkbenchHarness[];
  now: number;
  order?: "editor" | "drag";
}): WorkbenchModelGroup[] {
  const orderedHarnesses = [...allowedHarnesses].sort((left, right) => {
    const a = HARNESS_ORDER.indexOf(left as typeof HARNESS_ORDER[number]);
    const b = HARNESS_ORDER.indexOf(right as typeof HARNESS_ORDER[number]);
    return (a < 0 ? HARNESS_ORDER.length : a) - (b < 0 ? HARNESS_ORDER.length : b)
      || left.localeCompare(right);
  });
  const available = new Map<string, WorkbenchGroupedModel>();
  const providers: WorkbenchModelGroup[] = [];
  for (const harness of orderedHarnesses) {
    const models = (catalogues[harness] ?? []).filter(model => model.policyState !== "disabled");
    if (harness !== "opencode") {
      const entries = models.map(model => ({ harness, model }));
      entries.forEach(entry => available.set(modelKey(harness, entry.model.id), entry));
      providers.push({
        id: `provider:${harness}`, kind: "provider",
        label: harness === "claude" ? "Claude" : harness === "codex" ? "Codex" : harness,
        harness, models: entries,
      });
      continue;
    }
    const byProvider = Map.groupBy(models, model => openCodeProviderId(model.id));
    if (!byProvider.size) byProvider.set("opencode", []);
    for (const providerId of [...byProvider.keys()].sort((a, b) => a.localeCompare(b))) {
      const entries = byProvider.get(providerId)!.map(model => ({ harness, model }));
      entries.forEach(entry => available.set(modelKey(harness, entry.model.id), entry));
      providers.push({
        id: `provider:opencode:${providerId}`, kind: "provider",
        label: openCodeLabel(providerId), harness, providerId, models: entries,
      });
    }
  }
  const favouriteKeys = new Set(favourites.map(item => modelKey(item.harness, item.modelId)));
  const favouriteModels = [...favouriteKeys].flatMap(key => available.get(key) ?? []);
  favouriteModels.sort((a, b) => order === "drag"
    ? (a.model.lastUsedAt ?? 0) - (b.model.lastUsedAt ?? 0)
      || a.model.displayName.localeCompare(b.model.displayName)
    : a.model.displayName.localeCompare(b.model.displayName));
  const recentModels = [...available.values()]
    .filter(entry => entry.model.lastUsedAt !== null && entry.model.lastUsedAt !== undefined
      && entry.model.lastUsedAt >= now - WEEK_MS && entry.model.lastUsedAt <= now
      && !favouriteKeys.has(modelKey(entry.harness, entry.model.id)))
    .sort((a, b) => (order === "drag"
      ? (a.model.lastUsedAt ?? 0) - (b.model.lastUsedAt ?? 0)
      : (b.model.lastUsedAt ?? 0) - (a.model.lastUsedAt ?? 0))
      || a.model.displayName.localeCompare(b.model.displayName));
  const groups = [
    ...(favouriteModels.length ? [{ id: "favourites", kind: "favourites" as const, label: "Favourites", models: favouriteModels }] : []),
    ...(recentModels.length ? [{ id: "recent", kind: "recent" as const, label: "Recent", models: recentModels }] : []),
    ...providers,
  ];
  if (order === "editor") return groups;
  return groups.toReversed().map(group => group.kind === "provider" ? {
    ...group,
    models: [...group.models].sort((a, b) => a.model.displayName.localeCompare(b.model.displayName)),
  } : group);
}
