"use client";

/*
 * Exports:
 * - StatsActivityMetric: activity chart measure.
 * - default WorkbenchStatsActivity: stacked cost or token activity over the whole range, with period picking, category toggles, and unpriced-model disclosure.
 */
import type { StatsTokenType, WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchModeRow from "../WorkbenchModeRow";
import WorkbenchStatsBarChart from "./WorkbenchStatsBarChart";
import { compactNumber, formatMoney, formatStatsBucket, providerLabel } from "./stats-formatters";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

export type StatsActivityMetric = "cost" | "tokens";

export default function WorkbenchStatsActivity({ metric, onMetricChange, onPeriodPick, onTokenTypesChange, period, stats, tokenTypes }: {
  metric: StatsActivityMetric;
  onMetricChange: (metric: StatsActivityMetric) => void;
  /** Picks narrow the rest of the view; this chart always shows the whole range. */
  onPeriodPick: (startedAt: number, extend: boolean) => void;
  onTokenTypesChange: (tokenTypes: StatsTokenType[]) => void;
  period: { from: number; to: number } | null;
  stats: WorkbenchStatsResponse | null;
  tokenTypes: readonly StatsTokenType[];
}) {
  const shown = STATS_TOKEN_SERIES.filter(({ key }) => tokenTypes.includes(key));
  const buckets = stats?.tokens.buckets.map(({ startedAt }) => startedAt) ?? [];
  const first = period ? buckets.findIndex((startedAt) => startedAt >= period.from) : -1;
  const last = period ? buckets.findLastIndex((startedAt) => startedAt <= period.to) : -1;
  const picked = first >= 0 && last >= first ? { first, last } : null;
  const unit = stats?.bucketUnit ?? "day";
  const series = shown.map((entry) => ({
    key: entry.key, label: entry.label, fillClassName: entry.fillClassName, textClassName: entry.textClassName,
    values: metric === "cost"
      ? stats?.cost.buckets.map((bucket) => bucket.byTokenType[entry.key]) ?? []
      : stats?.tokens.buckets.map(entry.count) ?? [],
  }));
  const unpriced = stats?.cost.unpricedModels ?? [];
  const toggle = (key: StatsTokenType) => {
    const next = tokenTypes.includes(key) ? tokenTypes.filter((type) => type !== key) : [...tokenTypes, key];
    // An empty selection hides everything; keep at least one category visible.
    if (next.length) onTokenTypesChange(STATS_TOKEN_SERIES.map(({ key: type }) => type).filter((type) => next.includes(type)));
  };
  return (
    <section aria-labelledby="stats-activity-heading" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 text-[1rem] font-semibold text-text" id="stats-activity-heading">Activity</h2>
          <WorkbenchModeRow
            ariaLabel="Activity measure"
            onChange={onMetricChange}
            options={[{ label: "Cost", value: "cost" }, { label: "Tokens", value: "tokens" }]}
            value={metric}
          />
        </div>
        <div aria-label="Token categories" className="flex flex-wrap gap-1 [--hue-chroma:55%]" role="group">
          {STATS_TOKEN_SERIES.map(({ key, label, description, textClassName, Icon, count }) => {
            const on = tokenTypes.includes(key);
            const value = !stats ? null : metric === "cost" ? formatMoney(stats.cost.byTokenType[key]) : compactNumber(count(stats.tokens.totals));
            return (
              <button
                aria-pressed={on}
                className={`
                  inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.74rem] font-semibold transition
                  hover:bg-fg/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                  ${on ? textClassName : "text-fg/40 line-through decoration-1"}
                `}
                key={key}
                onClick={() => toggle(key)}
                title={`${description}. ${on ? "Hide" : "Show"} ${label.toLowerCase()}.`}
                type="button"
              >
                <Icon size={14} />{label}
                {value !== null && on ? <span className="font-normal tabular-nums opacity-80">{value}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="[--hue-chroma:55%]">
        <WorkbenchStatsBarChart
          buckets={buckets}
          formatBucket={(startedAt) => formatStatsBucket(startedAt, unit)}
          formatValue={metric === "cost" ? formatMoney : compactNumber}
          label={metric === "cost" ? "Estimated API cost per period" : "Tokens per period"}
          onPick={(index, extend) => { if (buckets[index] !== undefined) onPeriodPick(buckets[index], extend); }}
          picked={picked}
          series={series}
        />
      </div>
      {unpriced.length ? (
        <details className="group text-[0.74rem] text-fg/muted">
          <summary className="w-fit cursor-pointer list-none rounded-md px-1 hover:bg-fg/6 hover:text-text">
            <span className="text-hue-60 [--hue-chroma:70%]">●</span>{" "}
            {compactNumber(stats?.cost.basis.unpricedTokens ?? 0)} tokens from {unpriced.length} unpriced {unpriced.length === 1 ? "model" : "models"} are excluded from cost
          </summary>
          <ul className="m-0 mt-2 space-y-1 pl-5">
            {unpriced.map(({ model, provider, tokens }) => (
              <li key={`${provider}:${model ?? ""}`}>
                <span className="text-text">{model ?? "Unknown model"}</span> · {providerLabel(provider)} · {compactNumber(tokens)} tokens
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
