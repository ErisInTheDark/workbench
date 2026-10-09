"use client";

/*
 * Exports:
 * - default WorkbenchStatsView: feed the app's stats store its view facts, nudge history import and limit refresh, and render the shared controls and the routed tab.
 */
import { useContext, useEffect, useLayoutEffect, useState, type ComponentType } from "react";

import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkbenchStatsTab } from "workbench-shared/workbench/navigation/workbench-route";
import WorkbenchWorkspaceContext, { WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "../WorkbenchWorkspaceContext";
import type { StatsProjectScope } from "./stats-project-scope";
import useStats from "./use-stats";
import WorkbenchStatsControls from "./WorkbenchStatsControls";
import type { StatsInputs } from "./WorkbenchStatsStore";
import WorkbenchStatsToolsTab from "./tools/WorkbenchStatsToolsTab";
import WorkbenchStatsUsageTab from "./usage/WorkbenchStatsUsageTab";
import WorkbenchStatsWorkspacesTab from "./workspaces/WorkbenchStatsWorkspacesTab";

const TABS: Record<WorkbenchStatsTab, ComponentType> = {
  tools: WorkbenchStatsToolsTab,
  usage: WorkbenchStatsUsageTab,
  workspaces: WorkbenchStatsWorkspacesTab,
};

export default function WorkbenchStatsView({ onAddressFeedback, onOpenRoute, projects, scope, tab, threadRoute }: {
  /** Opens a new thread in the project, its composer seeded with the prompt. */
  onAddressFeedback: (projectId: string, prompt: string) => void;
  onOpenRoute: StatsInputs["openRoute"];
  threadRoute: StatsInputs["threadRoute"];
  projects: readonly WorkbenchProjectOption[];
  /** The sidebar selection, resolved onto this daemon's projects. */
  scope: StatsProjectScope;
  tab: WorkbenchStatsTab;
}) {
  const daemon = useContext(WorkbenchDaemonClientContext);
  const workspace = useContext(WorkbenchWorkspaceContext);
  const store = useStats.store();
  const [actionError, setActionError] = useState("");

  // Panels lease sections during render-time subscription, so app facts must land before they paint.
  useLayoutEffect(() => {
    store.setInputs({ addressFeedback: onAddressFeedback, openRoute: onOpenRoute, projects, scope, threadRoute });
  });

  // Commands only nudge the daemon; their effects stream back through the observations. They run on every
  // connection, so a cold load waits for the socket instead of failing before it opens.
  useEffect(() => {
    if (!daemon || !workspace) return;
    let active = true;
    const report = (error: unknown, fallback: string) => {
      if (active) setActionError(error instanceof Error ? error.message : fallback);
    };
    const nudge = () => {
      void daemon.stats.startImport()
        .then(() => { if (active) setActionError(""); })
        .catch((error: unknown) => report(error, "Unable to start history import."));
      void daemon.stats.refreshRateLimits().catch((error: unknown) => report(error, "Unable to refresh plan limits."));
    };
    const unsubscribeOpen = workspace.rpc.onOpen(nudge);
    if (workspace.rpc.connected) nudge();
    return () => {
      active = false;
      unsubscribeOpen();
    };
  }, [daemon, workspace]);

  const Tab = TABS[tab];
  return (
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-7 pb-10 pt-1">
      <WorkbenchStatsControls error={actionError} tab={tab} />
      <Tab key={tab} />
    </div>
  );
}
