"use client";

/*
 * Exports:
 * - default WorkbenchTokenUsage: own token-series visibility and render truthful token categories. Keywords: stats, tokens, checkbox, chart.
 */
import { useState } from "react";

import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsChart from "./WorkbenchStatsChart";
import { compactNumber } from "./stats-formatters";

type TokenSeries = "all" | "cachedInput" | "cacheWriteInput" | "output" | "uncachedInput";

const SERIES: ReadonlyArray<{
  colour: string;
  key: TokenSeries;
  label: string;
}> = [
  { colour: "var(--accent)", key: "uncachedInput", label: "new input" },
  { colour: "var(--muted)", key: "cachedInput", label: "cached input" },
  { colour: "color-mix(in srgb, var(--accent) 55%, var(--text))", key: "cacheWriteInput", label: "cache write" },
  { colour: "var(--text)", key: "output", label: "output" },
  { colour: "color-mix(in srgb, var(--accent) 35%, var(--text))", key: "all", label: "all" },
];

export default function WorkbenchTokenUsage({ stats }: { stats: WorkbenchStatsResponse }) {
  const [visible, setVisible] = useState<Record<TokenSeries, boolean>>({
    all: false,
    cachedInput: true,
    cacheWriteInput: true,
    output: true,
    uncachedInput: true,
  });
  const available = SERIES.filter(({ key }) => key !== "cacheWriteInput" || stats.tokens.totals.cacheWriteInput > 0);
  const shown = available.filter(({ key }) => visible[key]);
  return (
    <section aria-labelledby="tokens-heading" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-[1rem] font-semibold text-text" id="tokens-heading">Tokens</h2>
          <p className="m-0 mt-1 text-[0.72rem] text-muted">Input separates new, cached, and cache-write tokens.</p>
        </div>
        <div aria-label="Visible token series" className="flex flex-wrap gap-x-3 gap-y-1" role="group">
          {available.map(({ key, label }) => (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[0.72rem] text-muted" key={key}>
              <input
                checked={visible[key]}
                className="accent-accent"
                onChange={(event) => setVisible((current) => ({ ...current, [key]: event.target.checked }))}
                type="checkbox"
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      <WorkbenchStatsChart
        buckets={stats.tokens.buckets.map(({ startedAt }) => startedAt)}
        formatValue={compactNumber}
        series={shown.map(({ colour, key, label }) => ({
          colour,
          label,
          summary: compactNumber(stats.tokens.totals[key]),
          values: stats.tokens.buckets.map((bucket) => bucket[key]),
        }))}
        title="Token usage"
      />
    </section>
  );
}
