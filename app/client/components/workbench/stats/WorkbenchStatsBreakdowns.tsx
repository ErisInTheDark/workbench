"use client";

/*
 * Exports:
 * - default WorkbenchStatsBreakdowns: where usage went by project, provider, model, and thread; rows narrow the view when clicked.
 */
import type { MouseEvent, ReactNode } from "react";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { StatsActivityMetric } from "./WorkbenchStatsActivity";
import WorkbenchStatsShareList, { type StatsShareRow } from "./WorkbenchStatsShareList";
import WorkbenchStatsThreadRanking from "./WorkbenchStatsThreadRanking";
import { compactNumber, formatMoney, providerLabel, statsModelName, statsModelSource } from "./stats-formatters";
import { statsModelHueStyle } from "./stats-model-colours";

interface Share { costUsd: number; tokens: number; unpricedTokens: number; threadCount?: number }

function measure(metric: StatsActivityMetric, row: Share) {
  return metric === "cost" ? row.costUsd : row.tokens;
}

function rows<T extends Share>(metric: StatsActivityMetric, items: readonly T[], limit: number, row: (item: T) => Omit<StatsShareRow, "share" | "value">) {
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

export default function WorkbenchStatsBreakdowns({
  metric, model, modelHues, onModelChange, onNavigateThread, onProviderChange, onSelectProject, projectName, provider, showProjects, stats,
}: {
  metric: StatsActivityMetric;
  model: string | null;
  /** Shared with the thread bars so one model keeps one colour across panels. */
  modelHues: ReadonlyMap<string, number>;
  onModelChange: (provider: WorkbenchHarness, model: string | null) => void;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  onProviderChange: (provider: WorkbenchHarness | null) => void;
  onSelectProject?: (projectId: string) => void;
  projectName: (projectId: string) => string;
  provider: WorkbenchHarness | null;
  showProjects: boolean;
  stats: WorkbenchStatsResponse | null;
}) {
  const unit = metric === "cost" ? "spend" : "tokens";
  const threadCount = (count: number | undefined) => count === undefined ? null : `${count} ${count === 1 ? "thread" : "threads"}`;
  return (
    <section aria-labelledby="stats-breakdown-heading" className="space-y-4">
      <h2 className="m-0 text-[1rem] font-semibold text-text" id="stats-breakdown-heading">Where the {unit} went</h2>
      <div className={`grid gap-x-8 gap-y-6 ${showProjects ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {showProjects ? (
          <Panel title="Projects">
            <WorkbenchStatsShareList
              empty={stats ? "No project usage." : "-"}
              rows={rows(metric, stats?.projects ?? [], 8, (item) => ({
                key: item.projectId, label: projectName(item.projectId), detail: threadCount(item.threadCount),
                ...(onSelectProject ? { onSelect: () => onSelectProject(item.projectId), title: "Show only this project" } : {}),
              }))}
            />
          </Panel>
        ) : null}
        <Panel title="Providers">
          <WorkbenchStatsShareList
            empty={stats ? "No provider usage." : "-"}
            rows={rows(metric, stats?.providers ?? [], 6, (item) => ({
              key: item.provider, label: providerLabel(item.provider), detail: threadCount(item.threadCount),
              selected: provider === item.provider,
              onSelect: () => onProviderChange(provider === item.provider ? null : item.provider),
              title: provider === item.provider ? "Clear provider filter" : "Show only this provider",
            }))}
          />
        </Panel>
        <Panel title="Models">
          <WorkbenchStatsShareList
            empty={stats ? "No model usage." : "-"}
            rows={rows(metric, stats?.models ?? [], 8, (item) => ({
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
                onSelect: () => onModelChange(item.provider, model === item.model ? null : item.model),
                title: model === item.model ? "Clear model filter" : "Show only this model",
              } : {}),
            }))}
          />
        </Panel>
      </div>
      <Panel title={metric === "cost" ? "Most expensive threads" : "Busiest threads"}>
        <WorkbenchStatsThreadRanking
          empty={stats ? "No thread usage in this period." : "-"}
          metric={metric}
          modelHues={modelHues}
          onNavigateThread={onNavigateThread}
          projectName={projectName}
          showProjects={showProjects}
          threads={stats?.topThreads ?? []}
        />
      </Panel>
    </section>
  );
}
