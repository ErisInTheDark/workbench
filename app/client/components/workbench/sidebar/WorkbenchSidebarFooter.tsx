/*
 * Exports:
 * - default WorkbenchSidebarFooter: the sidebar's footer: one-signal threads, git and explorer pills that switch the panel
 *   above them, then the reload pill with this device's next reload action.
 */
"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import IconButton from "../../ui/IconButton";
import { useWorkingTree, useWorkingTreeSnapshot } from "../git/WorkbenchWorkingTreeProvider";
import { useLocalReloadDevice, useReloadSources, useRemoteReloadDevices } from "../reload/use-reload-devices";
import WorkbenchReloadFooterPill from "../reload/WorkbenchReloadFooterPill";
import { threadStatusPressedClassName } from "../thread-view/ThreadStatusRow";
import { useWorkbenchClientController } from "../workbench-client-context";
import { DraftThreadIcon, FolderOpenIcon, GitGraphIcon, NeedsAttentionThreadIcon } from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import type { WorkbenchSidebarPanel } from "./sidebar-panel";

const NO_SUBSCRIPTION = () => () => undefined;
const ATTENTION = "text-amber-600 dark:text-amber-300";

function Pill({ id, label, panel, onPanel, children }: {
  id: WorkbenchSidebarPanel; label: string; panel: WorkbenchSidebarPanel;
  onPanel(panel: WorkbenchSidebarPanel): void; children: ReactNode;
}) {
  const pressed = panel === id;
  return (
    <IconButton
      aria-pressed={pressed}
      className={pressed ? threadStatusPressedClassName : ""}
      display="hover-border"
      label={label}
      onClick={() => onPanel(id)}
      shape="pill"
      size="small"
    >
      <span className="inline-flex items-center gap-0.5 px-1.5 text-[0.8rem]">{children}</span>
    </IconButton>
  );
}

/** Threads waiting on you across the selected projects. */
function useWaitingThreads(projectIds: readonly string[]) {
  const facts = useWorkbenchClientController().mounted?.projectFacts ?? null;
  return useSyncExternalStore(facts?.subscribe ?? NO_SUBSCRIPTION, () => projectIds.reduce((total, id) =>
    total + (facts?.getSummary(id)?.counts.needsAttentionActive ?? 0), 0));
}

/** Whether the browsed folder has unclaimed changes, unpushed commits or commits a peer lacks. */
function useGitHasWork(location: ProjectLocationReference | null) {
  const tree = useWorkingTree();
  useEffect(() => location ? tree.acquireDemand("summary") : undefined, [location, tree]);
  const summary = useWorkingTreeSnapshot().summary;
  const { snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  if (!location) return false;
  return summary.repositories.some(repository => (repository.unclaimed ?? (repository.dirty ? 1 : 0)) > 0)
    || (snapshot.data?.upstream?.ahead ?? 0) > 0
    || (snapshot.data?.peers ?? []).some(peer => peer.state === "current" && peer.ahead > 0);
}

export default function WorkbenchSidebarFooter({
  panel, onPanel, projectIds, location, appRuntime, daemonRuntime, onAskAgent,
}: {
  panel: WorkbenchSidebarPanel;
  onPanel(panel: WorkbenchSidebarPanel): void;
  /** The selected projects whose threads count. */
  projectIds: readonly string[];
  /** The browsed folder whose git state counts. */
  location: ProjectLocationReference | null;
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  onAskAgent(projectId: string, references: readonly PresentationDraftReference[]): void;
}) {
  const waiting = useWaitingThreads(projectIds);
  const gitHasWork = useGitHasWork(location);
  const sources = useReloadSources(appRuntime);
  const local = useLocalReloadDevice({ appRuntime, daemonRuntime, sources, onAskAgent });
  const remotes = useRemoteReloadDevices({ appRuntime, sources });
  const shared = { panel, onPanel };
  return (
    <div className="flex min-w-0 items-center gap-0.5 px-1">
      <Pill {...shared} id="threads" label={waiting ? `Threads: ${waiting} waiting on you` : "Threads"}>
        {waiting ? <>
          <NeedsAttentionThreadIcon className={ATTENTION} size={14} />
          <span className={ATTENTION}>{waiting}</span>
        </> : <DraftThreadIcon size={14} />}
      </Pill>
      <Pill {...shared} id="git" label={gitHasWork ? "Git: changes to claim, push or send" : "Git"}>
        <span className="relative inline-flex">
          <GitGraphIcon size={14} />
          {gitHasWork ? <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent" /> : null}
        </span>
      </Pill>
      <Pill {...shared} id="explorer" label="Explorer"><FolderOpenIcon size={14} /></Pill>
      <span className="ml-auto flex min-w-0 justify-end">
        <WorkbenchReloadFooterPill
          local={local}
          onOpen={() => onPanel("reload")}
          pressed={panel === "reload"}
          remotes={remotes}
          tabOutOfDate={sources.tabOutOfDate && !sources.pullRunning}
        />
      </span>
    </div>
  );
}
