/*
 * Exports:
 * - compactNumber: format compact readable counts.
 * - formatMoney: format API-equivalent USD estimates, keeping small amounts legible.
 * - formatStatsDate: format one graph bucket date.
 * - formatStatsBucket: label one day or week bucket.
 * - formatPercent: format a percentage with one decimal below 10%.
 * - statsDelta: compare a value with the previous period as a signed percentage, or null when not comparable.
 * - formatResetIn: describe how long until a limit window resets.
 * - providerLabel: format harness identifiers for display.
 * - statsModelName: display name of a possibly namespaced model id.
 * - statsModelSource: billing source of a model, from its namespace or provider.
 */
import type { WorkbenchHarness } from "workbench-shared/types";

export function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    maximumFractionDigits: value === 0 ? 0 : value < 0.1 ? 3 : value < 1_000 ? 2 : 0,
    minimumFractionDigits: value === 0 ? 0 : value < 0.1 ? 3 : value < 1_000 ? 2 : 0,
    style: "currency",
  }).format(value);
}

export function formatStatsDate(timestamp: number, includeYear = false) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(includeYear ? { year: "numeric" as const } : {}),
  });
}

export function formatStatsBucket(timestamp: number, unit: "day" | "week") {
  const label = new Date(timestamp).toLocaleDateString(undefined, {
    day: "numeric", month: "short", timeZone: "UTC", ...(unit === "day" ? { weekday: "short" as const } : {}),
  });
  return unit === "week" ? `Week of ${label}` : label;
}

export function formatPercent(value: number) {
  return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
}

export function statsDelta(current: number, previous: number) {
  if (previous <= 0) return null;
  return (current - previous) / previous * 100;
}

export function formatResetIn(resetsAt: number | null, now: number) {
  if (resetsAt === null) return null;
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

export function providerLabel(provider: WorkbenchHarness) {
  if (provider === "opencode") return "OpenCode";
  return `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}

/** Namespaced ids (`opencode-go/mimo`) show the model; the namespace is its billing source. */
export function statsModelName(model: string | null) {
  return model ? model.slice(model.indexOf("/") + 1) : "Unknown model";
}

export function statsModelSource(provider: WorkbenchHarness, model: string | null) {
  return model?.includes("/") ? model.slice(0, model.indexOf("/")) : providerLabel(provider);
}
