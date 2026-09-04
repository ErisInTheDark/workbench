/*
 * Exports:
 * - compactNumber: format compact readable counts. Keywords: stats, number, tokens.
 * - formatMoney: format API-equivalent USD estimates. Keywords: stats, cost, USD.
 * - formatStatsDate: format one graph bucket date. Keywords: stats, date, graph.
 * - providerLabel: format harness identifiers for display. Keywords: stats, provider, label.
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
    maximumFractionDigits: value < 1 ? 4 : 2,
    style: "currency",
  }).format(value);
}

export function formatStatsDate(timestamp: number, includeYear = false) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" as const } : {}),
  });
}

export function providerLabel(provider: WorkbenchHarness) {
  if (provider === "opencode") return "OpenCode";
  return `${provider[0]!.toUpperCase()}${provider.slice(1)}`;
}
