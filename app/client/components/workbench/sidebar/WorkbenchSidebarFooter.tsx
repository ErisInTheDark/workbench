/*
 * Exports:
 * - default WorkbenchSidebarFooter: the sidebar's status counts bar: thread, git, explorer and reload pills that each show
 *   what needs attention and switch the panel above them.
 */
"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import IconButton from "../../ui/IconButton";
import { useWorkingTree, useWorkingTreeSnapshot } from "../git/WorkbenchWorkingTreeProvider";
import { mergeReloadDirt } from "../reload/reload-device";
import { threadStatusPressedClassName, threadStatusSegmentClassName } from "../thread-view/ThreadStatusRow";
import { useWorkbenchClientController } from "../workbench-client-context";
import {
  ArrowDownIcon, ArrowUpIcon, FolderOpenIcon, GitArcDirtyClaimIcon, NeedsAttentionThreadIcon, ReloadIcon,
  SendHorizontalIcon, SnoozedThreadIcon, WorkingThreadIcon,
} from "../workbench-icons";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import type { WorkbenchSidebarPanel } from "./sidebar-panel";

const NO_SUBSCRIPTION = () => () => undefined;
const SEGMENT = `${threadStatusSegmentClassName} !min-w-0 !gap-0.5 !px-0.5 first:!pl-1.5 last:!pr-1.5`;
const ATTENTION = "text-amber-600 dark:text-amber-300";

interface Segment { key: string; content: ReactNode }

function Pill({ id, label, panel, onPanel, segments }: {
  id: WorkbenchSidebarPanel; label: string; panel: WorkbenchSidebarPanel;
  onPanel(panel: WorkbenchSidebarPanel): void; segments: readonly Segment[];
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
      {segments.map(segment => <span className={SEGMENT} key={segment.key}>{segment.content}</span>)}
    </IconButton>
  );
}

/** Waiting on you, working and snoozed-with-attention threads across the selected projects. */
function useThreadCounts(projectIds: readonly string[]) {
  const facts = useWorkbenchClientController().mounted?.projectFacts ?? null;
  const key = useSyncExternalStore(facts?.subscribe ?? NO_SUBSCRIPTION, () => {
    let waiting = 0, active = 0, snoozed = 0;
    for (const id of projectIds) {
      const counts = facts?.getSummary(id)?.counts;
      if (!counts) continue;
      waiting += counts.needsAttentionActive;
      active += counts.working + (counts.waiting ?? 0);
      snoozed += counts.needsAttention;
    }
    return `${waiting}/${active}/${snoozed}`;
  });
  const [waiting = 0, active = 0, snoozed = 0] = key.split("/").map(Number);
  return { waiting, active, snoozed };
}

function useGitCounts(location: ProjectLocationReference | null) {
  const tree = useWorkingTree();
  useEffect(() => location ? tree.acquireDemand("summary") : undefined, [location, tree]);
  const summary = useWorkingTreeSnapshot().summary;
  const { snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  return {
    unclaimed: location ? summary.repositories.reduce((total, repository) =>
      total + (repository.unclaimed ?? (repository.dirty ? 1 : 0)), 0) : 0,
    unpushed: snapshot.data?.upstream?.ahead ?? 0,
    sendable: Math.max(0, ...(snapshot.data?.peers ?? []).filter(peer => peer.state === "current").map(peer => peer.ahead)),
  };
}

function useReloadHealth(appRuntime: WorkbenchAppRuntimeStore | null, daemonRuntime: WorkbenchDaemonRuntimeStore | null) {
  const app = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => appRuntime?.getSnapshot() ?? null, () => appRuntime?.getSnapshot() ?? null);
  const daemon = useSyncExternalStore(daemonRuntime?.subscribe ?? NO_SUBSCRIPTION,
    () => daemonRuntime?.getSnapshot() ?? null, () => daemonRuntime?.getSnapshot() ?? null);
  const update = useSyncExternalStore(daemonRuntime?.subscribeUpdate ?? NO_SUBSCRIPTION,
    () => daemonRuntime?.getUpdate() ?? null, () => daemonRuntime?.getUpdate() ?? null);
  const dirty = mergeReloadDirt(app, daemon)?.dirtyScopes ?? [];
  return {
    tone: dirty.some(scope => scope.destructive) ? "danger" as const
      : dirty.length || app?.tabOutOfDate ? "dirty" as const : "clean" as const,
    updates: update?.state === "available" || update?.state === "conflict" ? update.behind : 0,
  };
}

export default function WorkbenchSidebarFooter({ panel, onPanel, projectIds, location, appRuntime, daemonRuntime }: {
  panel: WorkbenchSidebarPanel;
  onPanel(panel: WorkbenchSidebarPanel): void;
  /** The selected projects whose threads count. */
  projectIds: readonly string[];
  /** The browsed folder whose git state counts. */
  location: ProjectLocationReference | null;
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
}) {
  const threads = useThreadCounts(projectIds);
  const git = useGitCounts(location);
  const reload = useReloadHealth(appRuntime, daemonRuntime);
  const shared = { panel, onPanel };
  return (
    <div className="flex min-w-0 items-center justify-between gap-0.5 px-1">
      <Pill {...shared} id="threads"
        label={`Threads: ${threads.waiting} waiting on you, ${threads.active} working, ${threads.snoozed} snoozed`}
        segments={[
          { key: "waiting", content: <>
            <NeedsAttentionThreadIcon className={threads.waiting ? ATTENTION : ""} size={14} />
            <span className={threads.waiting ? ATTENTION : ""}>{threads.waiting}</span>
          </> },
          { key: "working", content: <><WorkingThreadIcon size={14} />{threads.active}</> },
          { key: "snoozed", content: <><SnoozedThreadIcon size={14} />{threads.snoozed}</> },
        ]}
      />
      <Pill {...shared} id="git"
        label={`Git: ${git.unclaimed} unclaimed changes, ${git.unpushed} unpushed, ${git.sendable} to send`}
        segments={[
          { key: "unclaimed", content: <><GitArcDirtyClaimIcon size={14} />{git.unclaimed}</> },
          { key: "unpushed", content: <><ArrowUpIcon size={14} />{git.unpushed}</> },
          { key: "sendable", content: <><SendHorizontalIcon size={14} />{git.sendable}</> },
        ]}
      />
      <Pill {...shared} id="explorer" label="Explorer" segments={[{ key: "folder", content: <FolderOpenIcon size={16} /> }]} />
      <Pill {...shared} id="reload"
        label={reload.updates ? `Updates and reloads: ${reload.updates} updates available` : "Updates and reloads"}
        segments={[
          ...reload.updates ? [{ key: "updates", content: <><ArrowDownIcon size={12} />{reload.updates}</> }] : [],
          { key: "reload", content: <ReloadIcon
            className={reload.tone === "danger" ? "text-danger" : reload.tone === "dirty" ? "text-text" : ""} size={16} /> },
        ]}
      />
    </div>
  );
}
