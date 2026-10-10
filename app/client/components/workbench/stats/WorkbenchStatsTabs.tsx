/*
 * Exports:
 * - default WorkbenchStatsTabs: the stats view's tab row for the app shell header; each tab is a real link to its url.
 */
import type { MouseEvent } from "react";
import { WORKBENCH_STATS_TABS, type WorkbenchStatsTab } from "workbench-shared/workbench/navigation/workbench-route";
import Tabs, { Tab } from "../../ui/Tabs";

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
    <Tabs className="-ml-2 flex min-w-0 items-center gap-0.5 overflow-x-auto" label="Statistics">
      {WORKBENCH_STATS_TABS.map((candidate) => (
        <Tab
          as="a"
          href={href(candidate)}
          key={candidate}
          onClick={(event) => onSelect(event, candidate)}
          selected={candidate === tab}
          title={LABELS[candidate].title}
          variant="header"
        >
          {LABELS[candidate].label}
        </Tab>
      ))}
    </Tabs>
  );
}
