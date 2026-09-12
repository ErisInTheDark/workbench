"use client";

/*
 * Exports:
 * - default WorkbenchTokenUsage: render shared selected categories on independent scales.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { STATS_TOKEN_TYPES, type StatsTokenType } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import { compactNumber } from "./stats-formatters";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

export default function WorkbenchTokenUsage({ stats, selected = STATS_TOKEN_TYPES }: {
  stats: WorkbenchStatsResponse | null;
  selected?: readonly StatsTokenType[];
}) {
  const shown = STATS_TOKEN_SERIES.filter(({ key }) => selected.includes(key));
  return (
    <section aria-labelledby="tokens-heading" className="min-w-0 space-y-2">
      <div>
        <div>
          <h2 className="m-0 text-[1rem] font-semibold text-text" id="tokens-heading">Tokens</h2>
          <p className="m-0 mt-1 text-[0.72rem] text-muted">Independent scales. Cache includes reads and writes.</p>
        </div>
      </div>
      <WorkbenchStatsChart
        buckets={stats?.tokens.buckets.map(({ startedAt }) => startedAt) ?? []}
        formatValue={compactNumber}
        scale="independent"
        series={shown.map(({ colourClassName, label, count, Icon }) => ({
          colourClassName,
          label,
          icon: <Icon size={14} />,
          summary: stats ? compactNumber(count(stats.tokens.totals)) : "",
          values: stats?.tokens.buckets.map(count) ?? [],
        }))}
        title="Token usage"
      />
    </section>
  );
}
