/*
 * Exports:
 * - default WorkbenchStatsSummary: render compact headline usage metrics. Keywords: stats, summary, tokens, cost.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { compactNumber, formatMoney } from "./stats-formatters";

export default function WorkbenchStatsSummary({ stats }: { stats: WorkbenchStatsResponse }) {
  const items = [
    ["Total tokens", compactNumber(stats.tokens.totals.all)],
    ["API-equivalent cost", formatMoney(stats.cost.totalUsd)],
    ["Threads", compactNumber(stats.summary.threadCount)],
    ["Turns", compactNumber(stats.summary.turnCount)],
    ["Cache hit", `${stats.summary.cacheHitPercent.toFixed(1)}%`],
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([label, value]) => (
        <div className="min-w-0" key={label}>
          <dt className="text-[0.7rem] font-medium tracking-[0.06em] text-muted uppercase">{label}</dt>
          <dd className="m-0 mt-1 truncate text-[1.25rem] font-semibold text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
