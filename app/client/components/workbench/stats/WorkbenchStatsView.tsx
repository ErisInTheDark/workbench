"use client";

/*
 * Exports:
 * - default WorkbenchStatsView: own the stats store for the view's lifetime, nudge history import and limit refresh, and render the shared controls and the routed tab.
 */
import { useContext, useEffect, useLayoutEffect, useState, type ComponentType, type MouseEvent } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkbenchStatsTab } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchWorkspaceContext, { WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "../WorkbenchWorkspaceContext";
import type { StatsProjectScope } from "./stats-project-scope";
import { WorkbenchStatsProvider } from "./use-stats";
import WorkbenchStatsControls from "./WorkbenchStatsControls";
import WorkbenchStatsStore from "./WorkbenchStatsStore";
import WorkbenchStatsToolsTab from "./tools/WorkbenchStatsToolsTab";
import WorkbenchStatsUsageTab from "./usage/WorkbenchStatsUsageTab";
import WorkbenchStatsWorkspacesTab from "./workspaces/WorkbenchStatsWorkspacesTab";

const TABS: Record<WorkbenchStatsTab, ComponentType> = {
  tools: WorkbenchStatsToolsTab,
  usage: WorkbenchStatsUsageTab,
  workspaces: WorkbenchStatsWorkspacesTab,
};

export default function WorkbenchStatsView({ onAddressFeedback, onNavigateThread, projects, scope, tab }: {
  /** Opens a new thread in the project, its composer seeded with the prompt. */
  onAddressFeedback: (projectId: string, prompt: string) => void;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projects: readonly WorkbenchProjectOption[];
  /** The sidebar selection, resolved onto this daemon's projects. */
  scope: StatsProjectScope;
  tab: WorkbenchStatsTab;
}) {
  const daemon = useContext(WorkbenchDaemonClientContext);
  const workspace = useContext(WorkbenchWorkspaceContext);
  const [store] = useState(() => new WorkbenchStatsStore());
  const [actionError, setActionError] = useState("");

  // Panels lease sections during render-time subscription, so app facts must land before they paint.
  useLayoutEffect(() => {
    store.setInputs({ addressFeedback: onAddressFeedback, navigateThread: onNavigateThread, projects, scope, workspace });
  });
  useEffect(() => () => store.dispose(), [store]);

  // Commands only nudge the daemon; their effects stream back through the observations.
  useEffect(() => {
    if (!daemon) return;
    let active = true;
    const report = (error: unknown, fallback: string) => {
      if (active) setActionError(error instanceof Error ? error.message : fallback);
    };
    const start = () => daemon.stats.startImport()
      .then(() => { if (active) setActionError(""); })
      .catch((error: unknown) => report(error, "Unable to start history import."));
    const unsubscribeReconnect = daemon.onReconnect(() => { void start(); });
    void start();
    void daemon.stats.refreshRateLimits().catch((error: unknown) => report(error, "Unable to refresh plan limits."));
    return () => {
      active = false;
      unsubscribeReconnect();
    };
  }, [daemon]);

  const Tab = TABS[tab];
  return (
    <WorkbenchStatsProvider value={store}>
      <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-7 pb-10 pt-1">
        <WorkbenchStatsControls error={actionError} tab={tab} />
        <Tab key={tab} />
      </div>
    </WorkbenchStatsProvider>
  );
}
