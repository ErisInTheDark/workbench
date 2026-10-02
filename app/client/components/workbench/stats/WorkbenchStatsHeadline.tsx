/*
 * Exports:
 * - default WorkbenchStatsHeadline: headline cost, tokens, threads, turns, and cache rate over their trend, each compared with the previous period.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsSparkline from "./WorkbenchStatsSparkline";
import { compactNumber, formatMoney, formatPercent, statsDelta } from "./stats-formatters";

/** Only spend has a good direction; other counts change without being better or worse. */
function Delta({ current, previous, judged }: { current: number; previous: number; judged: boolean }) {
  const delta = statsDelta(current, previous);
  if (delta === null) return <span className="text-fg/muted">{current > 0 ? "new this period" : " "}</span>;
  const rounded = Math.round(delta);
  if (rounded === 0) return <span className="text-fg/muted">same as before</span>;
  return (
    <span className={!judged ? "text-fg/muted" : rounded > 0 ? "text-hue-40 [--hue-chroma:60%]" : "text-hue-150 [--hue-chroma:55%]"}>
      {rounded > 0 ? "▲" : "▼"} {Math.abs(rounded)}%<span className="text-fg/muted"> vs previous</span>
    </span>
  );
}

interface Card {
  label: string;
  value: string;
  trend: readonly (number | null)[];
  trendClassName: string;
  comparison?: { current: number; previous: number };
  primary?: boolean;
}

export default function WorkbenchStatsHeadline({ stats }: { stats: WorkbenchStatsResponse | null }) {
  const cache = stats?.cacheEfficiency.totals.cacheHitPercent ?? null;
  const cards: Card[] = [
    {
      label: "API-equivalent cost", value: stats ? formatMoney(stats.cost.totalUsd) : "-", primary: true,
      trend: stats?.cost.buckets.map(({ totalUsd }) => totalUsd) ?? [], trendClassName: "text-hue-40",
      ...(stats ? { comparison: { current: stats.cost.totalUsd, previous: stats.previous.costUsd } } : {}),
    },
    {
      label: "Tokens", value: stats ? compactNumber(stats.tokens.totals.all) : "-",
      trend: stats?.tokens.buckets.map(({ all }) => all) ?? [], trendClassName: "text-hue-210",
      ...(stats ? { comparison: { current: stats.tokens.totals.all, previous: stats.previous.tokens } } : {}),
    },
    {
      label: "Threads", value: stats ? compactNumber(stats.summary.threadCount) : "-",
      trend: stats?.summary.buckets.map(({ threadCount }) => threadCount) ?? [], trendClassName: "text-hue-260",
      ...(stats ? { comparison: { current: stats.summary.threadCount, previous: stats.previous.threadCount } } : {}),
    },
    {
      label: "Turns", value: stats ? compactNumber(stats.summary.turnCount) : "-",
      trend: stats?.summary.buckets.map(({ turnCount }) => turnCount) ?? [], trendClassName: "text-hue-170",
      ...(stats ? { comparison: { current: stats.summary.turnCount, previous: stats.previous.turnCount } } : {}),
    },
    {
      label: "Input cache hits", value: cache === null ? "-" : formatPercent(cache),
      trend: stats?.cacheEfficiency.buckets.map(({ cacheHitPercent }) => cacheHitPercent) ?? [], trendClassName: "text-hue-300",
    },
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [--hue-chroma:55%]">
      {cards.map(({ label, value, trend, trendClassName, comparison, primary }) => (
        <div className={`relative min-w-0 overflow-hidden rounded-lg px-3 pb-3 pt-2.5 ${primary ? "col-span-2 sm:col-span-1" : ""}`} key={label}>
          <WorkbenchStatsSparkline className={trendClassName} values={trend} />
          <dt className="relative text-[0.72rem] font-medium text-fg/muted">{label}</dt>
          <dd className={`relative m-0 mt-0.5 truncate font-semibold tabular-nums text-text ${primary ? "text-[1.9rem] leading-tight" : "text-[1.35rem] leading-snug"}`}>{value}</dd>
          <dd className="relative m-0 truncate text-[0.7rem] tabular-nums">
            {comparison ? <Delta current={comparison.current} judged={Boolean(primary)} previous={comparison.previous} /> : " "}
          </dd>
        </div>
      ))}
    </dl>
  );
}
