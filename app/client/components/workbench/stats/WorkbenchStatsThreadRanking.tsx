"use client";

/*
 * Exports:
 * - default WorkbenchStatsThreadRanking: top threads with bars split by model; hovering a segment highlights its model, hovering a title shows its thread tooltip.
 */
import { useState, type MouseEvent } from "react";
import { createThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import WorkbenchThreadHoverTooltip from "../WorkbenchThreadHoverTooltip";
import type { StatsActivityMetric } from "./WorkbenchStatsActivity";
import { compactNumber, formatMoney, providerLabel, statsModelName } from "./stats-formatters";
import { statsThreadIdentity } from "./stats-thread-identity";
import { statsModelHueStyle } from "./stats-model-colours";

type Thread = WorkbenchStatsResponse["topThreads"][number];

export default function WorkbenchStatsThreadRanking({ empty, metric, modelHues, onNavigateThread, projectName, showProjects, threads }: {
  empty: string;
  metric: StatsActivityMetric;
  modelHues: ReadonlyMap<string, number>;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projectName: (projectId: string) => string;
  showProjects: boolean;
  threads: readonly Thread[];
}) {
  const projectHref = useWorkbenchProjectNavigation();
  const [hovered, setHovered] = useState<{ thread: string; model: string } | null>(null);
  const measure = (item: { costUsd: number; tokens: number }) => metric === "cost" ? item.costUsd : item.tokens;
  const sorted = [...threads].sort((left, right) => measure(right) - measure(left)).slice(0, 12);
  const maximum = Math.max(0, ...sorted.map(measure)) || 1;
  if (!sorted.length) return <p className="m-0 py-1 text-[0.8rem] text-fg/muted">{empty}</p>;
  return (
    <ol className="m-0 grid gap-y-1 p-0">
      {sorted.map((thread) => {
        const key = `${thread.projectId}:${thread.threadId}`;
        // Daemons before the model split only know model names; one neutral segment stands in.
        const segments = (thread.modelShares.length ? thread.modelShares : [{ ...thread, model: null, provider: "" }])
          .filter((share) => measure(share) > 0)
          .map(({ costUsd, model, provider, tokens }) => ({ costUsd, key: `${provider}:${model ?? ""}`, model, tokens }));
        const names = thread.modelShares.length
          ? thread.modelShares.map(({ model }) => model ?? "")
          : thread.models.length ? thread.models : thread.providers.map(providerLabel);
        const active = hovered?.thread === key ? hovered.model : null;
        return (
          <li className="list-none rounded-md px-2 pb-2 pt-1.5" key={key}>
            <div className="flex min-w-0 items-baseline justify-between gap-3 text-[0.8rem]">
              <span className="flex min-w-0 items-baseline gap-2">
                <WorkbenchThreadHoverTooltip thread={statsThreadIdentity(thread)} title={thread.title || thread.threadId}>
                  <a
                    className="min-w-0 truncate rounded-sm font-medium text-text hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                    href={projectHref(createThreadRoute(thread.projectId, thread.threadId))}
                    onClick={(event) => onNavigateThread(event, thread.projectId, thread.threadId)}
                  >
                    {thread.title || thread.threadId}
                  </a>
                </WorkbenchThreadHoverTooltip>
                <span className="min-w-0 shrink-[4] truncate text-[0.72rem] text-fg/muted">
                  {showProjects ? `${projectName(thread.projectId)} · ` : ""}
                  {names.map((name, index) => (
                    <span key={`${name}:${index}`}>
                      {index ? ", " : ""}
                      <span className={`transition-colors ${active === null ? "" : active === name ? "font-semibold text-text" : "opacity-50"}`}>
                        {thread.modelShares.length ? statsModelName(name || null) : name}
                      </span>
                    </span>
                  ))}
                </span>
              </span>
              <span className="shrink-0 text-[0.76rem] font-semibold tabular-nums text-text">
                {metric === "cost"
                  ? thread.unpricedTokens && !thread.costUsd ? "unpriced" : formatMoney(thread.costUsd)
                  : compactNumber(thread.tokens)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fg/6">
              <div
                className="flex h-full gap-px overflow-hidden rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                onPointerLeave={() => setHovered(null)}
                style={{ width: `${Math.max(1, measure(thread) / maximum * 100)}%` }}
              >
                {segments.map((segment) => {
                  const name = segment.model ?? "";
                  const hue = segment.model ? modelHues.get(segment.model) : undefined;
                  return (
                    <span
                      className={`
                        h-full min-w-px transition-opacity duration-150 motion-reduce:transition-none [--hue-chroma:55%]
                        ${hue === undefined ? "bg-fg/40" : "bg-hue-[var(--model-hue)]"}
                        ${active !== null && active !== name ? "opacity-35" : ""}
                      `}
                      key={segment.key}
                      onPointerEnter={() => setHovered({ thread: key, model: name })}
                      style={{ ...statsModelHueStyle(hue), flexGrow: measure(segment) }}
                      title={`${statsModelName(segment.model)} · ${metric === "cost" ? formatMoney(segment.costUsd) : compactNumber(segment.tokens)}`}
                    />
                  );
                })}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
