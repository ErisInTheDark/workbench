"use client";

/*
 * Exports:
 * - default WorkbenchStatsActivity: stacked cost, token, or per-provider plan limit activity over the whole range, with period
 *   picking, category toggles, and unpriced-model disclosure.
 */
import { useState } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { StatsTokenType } from "workbench-shared/workbench/stats/workbench-stats-contract";
import RadioRow from "../../../ui/RadioRow";
import useStats from "../use-stats";
import StreamChart from "../../../ui/StreamChart";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import { compactNumber, formatMoney, formatPercent, formatStatsBucket, providerLabel } from "../stats-formatters";
import type { StatsActivityMetric } from "../WorkbenchStatsStore";
import StatsLoading from "../StatsLoading";
import { limitResolution, providerWeeklyUsage } from "./stats-limit-usage";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

// A deterministic stream silhouette for the loading chart, so it reads as a chart without pretending to be data.
const SKELETON_HEIGHTS = [38, 52, 30, 64, 46, 72, 58, 41, 66, 49, 35, 57, 70, 44];
const SKELETON_STREAM = `polygon(0% 100%, ${SKELETON_HEIGHTS.map((height, index) =>
  `${(index / (SKELETON_HEIGHTS.length - 1) * 100).toFixed(2)}% ${100 - height}%`).join(", ")}, 100% 100%)`;

const DAY_MS = 86_400_000;
const PROVIDER_TEXT: Partial<Record<WorkbenchHarness, string>> = {
  claude: "text-hue-40", codex: "text-hue-170", copilot: "text-hue-260", opencode: "text-hue-210",
};
const SPARE_TEXT = ["text-hue-320", "text-hue-100", "text-hue-290", "text-hue-130"] as const;

type ActivityMeasure = StatsActivityMetric | "usage";
const MEASURES: ReadonlyArray<{ label: string; title?: string; value: ActivityMeasure }> = [
  { label: "Cost", value: "cost" },
  { label: "Tokens", value: "tokens" },
  { label: "Usage", title: "Plan limit use, as a share of a week's allowance", value: "usage" },
];

/** Always the whole range: picking periods narrows every other usage panel. */
export default function WorkbenchStatsActivity() {
  const filters = useStats();
  const overview = useStats.overview();
  const limitsSection = useStats.limits();
  const stats = overview.data;
  const limits = limitsSection.data;
  // Plan use has no cost or token split, so breakdowns keep measuring by the shared metric while this chart shows it.
  const [planUsage, setPlanUsage] = useState(false);
  const { metric, period, tokenTypes } = filters;
  const measure: ActivityMeasure = planUsage ? "usage" : metric;
  // Machines answer one by one; until the last does, the chart shows only part of the picture.
  const pending = overview.loading || overview.refining || (planUsage && (limitsSection.loading || limitsSection.refining));
  const shown = STATS_TOKEN_SERIES.filter(({ key }) => tokenTypes.includes(key));
  const buckets = stats?.tokens.buckets.map(({ startedAt }) => startedAt) ?? [];
  const unit = stats?.bucketUnit ?? "day";
  const unitMs = unit === "week" ? 7 * DAY_MS : DAY_MS;
  // Plan use is sampled far more often than days, so it draws on fine buckets that nest inside the period buckets.
  const fine = limitResolution(buckets[0] ?? 0, limits?.generatedAt ?? (buckets.at(-1) ?? 0) + unitMs);
  const chartBuckets = planUsage && buckets.length ? Array.from({ length: fine.count }, (_, index) => fine.startedAt + index * fine.bucketMs) : buckets;
  const first = period ? chartBuckets.findIndex((startedAt) => startedAt >= period.from) : -1;
  const last = period ? chartBuckets.findLastIndex((startedAt) => startedAt < period.to + unitMs) : -1;
  const picked = first >= 0 && last >= first ? { first, last } : null;
  const pick = (index: number, extend: boolean) => {
    const at = chartBuckets[index];
    const bucket = at === undefined ? undefined : buckets.findLast((startedAt) => startedAt <= at);
    if (bucket !== undefined) filters.pickPeriod(bucket, extend);
  };
  const formatBucket = (startedAt: number) => planUsage
    ? new Date(startedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", weekday: "short" })
    : formatStatsBucket(startedAt, unit);
  const series = planUsage
    ? providerWeeklyUsage(limits?.rateLimits ?? [], fine).map(({ key, harness, name, values }, index, all) => {
      // A provider's first account keeps its colour; further accounts take the spare hues.
      const sameProviderBefore = all.slice(0, index).filter((other) => other.harness === harness).length;
      const textClassName = (sameProviderBefore ? undefined : PROVIDER_TEXT[harness]) ?? SPARE_TEXT[index % SPARE_TEXT.length]!;
      return { key, label: name ? `${providerLabel(harness)} · ${name.short}` : providerLabel(harness), textClassName, values };
    })
    : shown.map((entry) => ({
      key: entry.key, label: entry.label, textClassName: entry.textClassName,
      values: metric === "cost"
        ? stats?.cost.buckets.map((bucket) => bucket.byTokenType[entry.key]) ?? []
        : stats?.tokens.buckets.map(entry.count) ?? [],
    }));
  const chart = {
    cost: { emptyLabel: "No usage in this period", formatValue: formatMoney, label: "Estimated API cost per period" },
    tokens: { emptyLabel: "No usage in this period", formatValue: compactNumber, label: "Tokens per period" },
    usage: { emptyLabel: "No plan limit use in this period", formatValue: formatPercent, label: "Plan limit use over time, as a share of a week's allowance" },
  }[measure];
  const unpriced = planUsage ? [] : stats?.cost.unpricedModels ?? [];
  const toggle = (key: StatsTokenType) => {
    const next = tokenTypes.includes(key) ? tokenTypes.filter((type) => type !== key) : [...tokenTypes, key];
    // An empty selection hides everything; keep at least one category visible.
    if (next.length) filters.setTokenTypes(STATS_TOKEN_SERIES.map(({ key: type }) => type).filter((type) => next.includes(type)));
  };
  return (
    <section aria-busy={pending} aria-labelledby="stats-activity-heading" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="m-0 text-[1rem] font-semibold text-text" id="stats-activity-heading">Activity</h2>
          <RadioRow
            ariaLabel="Activity measure"
            onChange={(next) => {
              setPlanUsage(next === "usage");
              if (next !== "usage") filters.setMetric(next);
            }}
            options={MEASURES}
            value={measure}
          />
          {pending && stats ? <StatsLoading /> : null}
        </div>
        <div aria-label="Token categories" className={`flex flex-wrap gap-1 [--hue-chroma:55%] ${planUsage ? "invisible" : ""}`} role="group">
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
                {value !== null && on ? <span className={`font-normal tabular-nums opacity-80 ${statsRevealClassName}`}>{value}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      {stats && (!planUsage || limits) ? (
        <div className={`[--hue-chroma:55%] ${statsRevealClassName} ${statsReloadingClassName(pending)}`}>
          <StreamChart
            buckets={chartBuckets}
            emptyLabel={chart.emptyLabel}
            formatBucket={formatBucket}
            formatValue={chart.formatValue}
            label={chart.label}
            onPick={pick}
            picked={picked}
            series={series}
          />
        </div>
      ) : (
        <div aria-hidden="true" className="space-y-3">
          <Skeleton className="h-48 rounded-none" style={{ clipPath: SKELETON_STREAM }} />
          <div className="flex h-[1.02rem] items-center justify-between"><Skeleton className="h-2.5 w-12" /><Skeleton className="h-2.5 w-12" /></div>
          <div className="flex min-h-10 items-start"><Skeleton className="mt-1 h-3 w-40" /></div>
        </div>
      )}
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
