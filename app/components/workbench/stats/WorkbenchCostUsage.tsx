/*
 * Exports:
 * - default WorkbenchCostUsage: render API-equivalent cost and estimate provenance. Keywords: stats, cost, pricing, attribution.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import { compactNumber, formatMoney } from "./stats-formatters";

export default function WorkbenchCostUsage({ stats }: { stats: WorkbenchStatsResponse }) {
  const basis = stats.cost.basis;
  const total = basis.exactModelTokens
    + basis.threadInferredModelTokens
    + basis.projectInferredModelTokens
    + basis.defaultModelTokens;
  const share = (value: number) => total ? `${(value / total * 100).toFixed(1)}%` : "0%";
  return (
    <section aria-labelledby="cost-heading" className="min-w-0 space-y-4">
      <div>
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="cost-heading">API-equivalent cost</h2>
        <p className="m-0 mt-1 text-[0.72rem] text-muted">Current catalogue estimate, not a subscription invoice.</p>
      </div>
      <WorkbenchStatsChart
        buckets={stats.cost.buckets.map(({ startedAt }) => startedAt)}
        formatValue={formatMoney}
        series={[{
          colour: "var(--accent)",
          label: "estimated cost",
          summary: formatMoney(stats.cost.totalUsd),
          values: stats.cost.buckets.map(({ totalUsd }) => totalUsd),
        }]}
        title="Estimated cost"
      />
      <details className="text-[0.72rem] leading-5 text-muted">
        <summary className="w-fit cursor-pointer rounded-md px-1 py-0.5 hover:bg-surface-hover hover:text-text">
          Estimate basis · catalogue {stats.pricingCatalogDate}
        </summary>
        <dl className="m-0 mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt>Exact model</dt><dd className="m-0 text-text">{share(basis.exactModelTokens)} · {compactNumber(basis.exactModelTokens)}</dd></div>
          <div><dt>Thread-inferred</dt><dd className="m-0 text-text">{share(basis.threadInferredModelTokens)} · {compactNumber(basis.threadInferredModelTokens)}</dd></div>
          <div><dt>Project-inferred</dt><dd className="m-0 text-text">{share(basis.projectInferredModelTokens)} · {compactNumber(basis.projectInferredModelTokens)}</dd></div>
          <div><dt>Provider default</dt><dd className="m-0 text-text">{share(basis.defaultModelTokens)} · {compactNumber(basis.defaultModelTokens)}</dd></div>
        </dl>
      </details>
    </section>
  );
}
