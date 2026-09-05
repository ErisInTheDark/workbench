/*
 * Exports:
 * - default WorkbenchCostUsage: render API-equivalent cost and estimate provenance. Keywords: stats, cost, pricing, attribution.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { hasStatsCategoryCosts, STATS_TOKEN_TYPES, type StatsTokenType } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import { compactNumber, formatMoney } from "./stats-formatters";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

export default function WorkbenchCostUsage({ stats, selected = STATS_TOKEN_TYPES }: {
  stats: WorkbenchStatsResponse | null;
  selected?: readonly StatsTokenType[];
}) {
  const detailed = stats && hasStatsCategoryCosts(stats) ? stats : null;
  const basis = stats?.cost.basis ?? { exactModelTokens: 0, threadInferredModelTokens: 0, projectInferredModelTokens: 0, defaultModelTokens: 0 };
  const total = basis.exactModelTokens
    + basis.threadInferredModelTokens
    + basis.projectInferredModelTokens
    + basis.defaultModelTokens;
  const share = (value: number) => total ? `${(value / total * 100).toFixed(1)}%` : "0%";
  return (
    <section aria-labelledby="cost-heading" className="min-w-0 space-y-4">
      <div className="h-16">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="cost-heading">API-equivalent cost</h2>
        <p className="m-0 mt-1 text-[0.72rem] text-muted">Current catalogue estimate, not a subscription invoice.</p>
      </div>
      <WorkbenchStatsChart
        buckets={stats?.cost.buckets.map(({ startedAt }) => startedAt) ?? []}
        formatValue={formatMoney}
        series={detailed ? STATS_TOKEN_SERIES.filter(({ key }) => selected.includes(key)).map(({ key, colour, label, Icon }) => ({
          colour, label, icon: <Icon className="size-3.5" />,
          summary: formatMoney(detailed.cost.byTokenType[key]),
          values: detailed.cost.buckets.map((bucket) => bucket.byTokenType[key]),
        })) : stats ? [{
          colour: "var(--accent)",
          label: "estimated cost",
          summary: formatMoney(stats.cost.totalUsd),
          values: stats.cost.buckets.map(({ totalUsd }) => totalUsd),
        }] : []}
        title="Estimated cost"
      />
      <details className="relative h-6 text-[0.72rem] leading-5 text-muted" onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}>
        <summary className="w-fit cursor-pointer rounded-md px-1 py-0.5 hover:bg-surface-hover hover:text-text">
          Estimate basis · catalogue {stats?.pricingCatalogDate ?? "-"}
        </summary>
        <dl className="absolute inset-x-0 top-full z-10 m-0 mt-2 grid max-h-64 gap-x-4 gap-y-1 overflow-auto rounded-lg bg-bg p-4 shadow-float sm:grid-cols-2">
          <div><dt>Exact model</dt><dd className="m-0 text-text">{share(basis.exactModelTokens)} · {compactNumber(basis.exactModelTokens)}</dd></div>
          <div><dt>Thread-inferred</dt><dd className="m-0 text-text">{share(basis.threadInferredModelTokens)} · {compactNumber(basis.threadInferredModelTokens)}</dd></div>
          <div><dt>Project-inferred</dt><dd className="m-0 text-text">{share(basis.projectInferredModelTokens)} · {compactNumber(basis.projectInferredModelTokens)}</dd></div>
          <div><dt>Provider default</dt><dd className="m-0 text-text">{share(basis.defaultModelTokens)} · {compactNumber(basis.defaultModelTokens)}</dd></div>
        </dl>
      </details>
    </section>
  );
}
