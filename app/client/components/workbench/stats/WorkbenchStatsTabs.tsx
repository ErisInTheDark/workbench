/*
 * Exports:
 * - default WorkbenchStatsTabs: the stats view's tab row for the app shell header; each tab is a real link to its url.
 */
import type { MouseEvent } from "react";
import { WORKBENCH_STATS_TABS, type WorkbenchStatsTab } from "workbench-shared/workbench/navigation/workbench-route";

const LABELS: Record<WorkbenchStatsTab, { label: string; title: string }> = {
  usage: { label: "Usage", title: "Providers, models, cost and tokens" },
  workspaces: { label: "Workspaces", title: "Contended files and agent feedback" },
  tools: { label: "Tools", title: "Tool calls against the prompt tokens they cost" },
};

export default function WorkbenchStatsTabs({ href, onSelect, tab }: {
  href: (tab: WorkbenchStatsTab) => string | undefined;
  onSelect: (event: MouseEvent<HTMLAnchorElement>, tab: WorkbenchStatsTab) => void;
  tab: WorkbenchStatsTab;
}) {
  return (
    <nav aria-label="Statistics" className="-ml-2 flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {WORKBENCH_STATS_TABS.map((candidate) => {
        const current = candidate === tab;
        return (
          <a
            aria-current={current ? "page" : undefined}
            className={`
              relative shrink-0 rounded-lg px-2.5 py-1 text-base font-semibold leading-tight transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
              after:(absolute inset-x-2.5 -bottom-1 h-0.5 rounded-full bg-current transition-opacity content-[''])
              ${current ? "text-text after:opacity-100" : "text-fg/muted after:opacity-0 hover:bg-fg/6 hover:text-text"}
            `}
            href={href(candidate)}
            key={candidate}
            onClick={(event) => onSelect(event, candidate)}
            title={LABELS[candidate].title}
          >
            {LABELS[candidate].label}
          </a>
        );
      })}
    </nav>
  );
}
