"use client";

/*
 * Exports:
 * - default WorkbenchStatsBreakdowns: where usage went by project, provider, model, and thread; rows narrow the view when clicked.
 */
import { useMemo, type ReactNode } from "react";
import type { StatsActivityMetric } from "../WorkbenchStatsStore";
import useStats from "../use-stats";
import { statsReloadingClassName } from "../WorkbenchStatsSkeleton";
import WorkbenchStatsShareList, { type StatsShareRow } from "../WorkbenchStatsShareList";
import WorkbenchStatsThreadRanking from "./WorkbenchStatsThreadRanking";
import { compactNumber, formatMoney, providerLabel, statsModelName, statsModelSource } from "../stats-formatters";
import { statsModelHues, statsModelHueStyle } from "./stats-model-colours";

interface Share { costUsd: number; tokens: number; unpricedTokens: number; threadCount?: number }

function measure(metric: StatsActivityMetric, row: Share) {
  return metric === "cost" ? row.costUsd : row.tokens;
}

function rows<T extends Share>(metric: StatsActivityMetric, items: readonly T[] | null, limit: number, row: (item: T) => Omit<StatsShareRow, "share" | "value">) {
  if (!items) return null;
  const sorted = [...items].sort((left, right) => measure(metric, right) - measure(metric, left)).slice(0, limit);
  const maximum = Math.max(0, ...sorted.map((item) => measure(metric, item))) || 1;
  return sorted.map((item) => ({
    ...row(item),
    share: measure(metric, item) / maximum,
    value: metric === "cost"
      ? item.unpricedTokens && !item.costUsd ? "unpriced" : formatMoney(item.costUsd)
      : compactNumber(item.tokens),
  }));
}

function Panel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="m-0 px-2 text-[0.74rem] font-semibold text-fg/muted">{title}</h3>
      {children}
    </div>
  );
}

/** Every model in the whole window, so narrowing to one model never repaints the others. */
export function useStatsModelHues() {
  const models = useStats.overview().data?.usageFilters.models;
  return useMemo(() => statsModelHues(models ?? []), [models]);
}

export default function WorkbenchStatsBreakdowns() {
  const filters = useStats();
  const { data: stats, loading } = useStats.usage();
  const modelHues = useStatsModelHues();
  const { metric, model, provider, showProjects } = filters;
  const unit = metric === "cost" ? "spend" : "tokens";
  const threadCount = (count: number | undefined) => count === undefined ? null : `${count} ${count === 1 ? "thread" : "threads"}`;
  return (
    <section aria-busy={loading} aria-labelledby="stats-breakdown-heading" className={`space-y-4 ${statsReloadingClassName(loading && Boolean(stats))}`}>
      <h2 className="m-0 text-[1rem] font-semibold text-text" id="stats-breakdown-heading">Where the {unit} went</h2>
      <div className={`grid gap-x-8 gap-y-6 ${showProjects ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {showProjects ? (
          <Panel title="Projects">
            <WorkbenchStatsShareList
              empty="No project usage."
              rows={rows(metric, stats?.projects ?? null, 8, (item) => ({
                key: item.projectId, label: filters.projectName(item.projectId), detail: threadCount(item.threadCount),
                onSelect: () => filters.focusProject(item.projectId), title: "Show only this project",
              }))}
            />
          </Panel>
        ) : null}
        <Panel title="Providers">
          <WorkbenchStatsShareList
            empty="No provider usage."
            loadingRows={2}
            rows={rows(metric, stats?.providers ?? null, 6, (item) => ({
              key: item.provider, label: providerLabel(item.provider), detail: threadCount(item.threadCount),
              selected: provider === item.provider,
              onSelect: () => filters.setProvider(provider === item.provider ? null : item.provider),
              title: provider === item.provider ? "Clear provider filter" : "Show only this provider",
            }))}
          />
        </Panel>
        <Panel title="Models">
          <WorkbenchStatsShareList
            empty="No model usage."
            rows={rows(metric, stats?.models ?? null, 8, (item) => ({
              key: `${item.provider}:${item.model ?? ""}`,
              label: <>{statsModelName(item.model)}{item.inferredModelTokens ? <span className="text-fg/muted" title="Model inferred from thread or project settings">~</span> : null}</>,
              detail: statsModelSource(item.provider, item.model),
              ...(item.model && modelHues.has(item.model) ? {
                barClassName: "bg-hue-[var(--model-hue)] [--hue-chroma:55%]",
                barStyle: statsModelHueStyle(modelHues.get(item.model)),
              } : {}),
              title: item.model ?? undefined,
              selected: item.model !== null && model === item.model,
              ...(item.model ? {
                onSelect: () => filters.setModel(item.provider, model === item.model ? null : item.model),
                title: model === item.model ? "Clear model filter" : "Show only this model",
              } : {}),
            }))}
          />
        </Panel>
      </div>
      <Panel title={metric === "cost" ? "Most expensive threads" : "Busiest threads"}>
        <WorkbenchStatsThreadRanking modelHues={modelHues} threads={stats?.topThreads ?? null} />
      </Panel>
    </section>
  );
}
